import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as path from 'path';

export interface AwsServiceHeroesBackendStackProps extends cdk.StackProps {
  /** Vercel team slug that owns the frontend project (OIDC issuer path). */
  vercelTeamSlug: string;
  /** Vercel project name allowed to assume the frontend role. */
  vercelProjectName: string;
  /** Auth0 tenant domain, e.g. demo-showcase.us.auth0.com */
  auth0Domain: string;
  /** Auth0 client id of the booth app (used by the completion Lambda). */
  auth0ClientId: string;
  /** Secrets Manager secret name holding the Auth0 client secret (plain string). */
  auth0ClientSecretName: string;
  /** owner/repo that receives the hero issues. */
  githubIssueRepo: string;
  /** Bedrock Luma model id. */
  lumaModelId?: string;
}

export class AwsServiceHeroesBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AwsServiceHeroesBackendStackProps) {
    super(scope, id, props);

    const lumaModelId = props.lumaModelId ?? 'luma.ray-v2:0';

    // ---- Assets: originals, generated stills, Luma mp4s -------------------
    const bucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const distribution = new cloudfront.Distribution(this, 'AssetsCdn', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
      },
      comment: 'AWS Service Heroes assets',
    });

    // ---- Hero job records ---------------------------------------------------
    const table = new dynamodb.TableV2(this, 'HeroesTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: 'byCreatedAt',
          partitionKey: { name: 'entity', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // ---- Completion Lambda: mp4 lands -> mark record + patch GitHub issue ---
    const auth0Secret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'Auth0ClientSecret',
      props.auth0ClientSecretName,
    );

    const completeFn = new lambda.Function(this, 'VideoCompleteFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'video-complete')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'VideoCompleteLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        HEROES_TABLE_NAME: table.tableName,
        ASSETS_CDN_DOMAIN: distribution.distributionDomainName,
        AUTH0_DOMAIN: props.auth0Domain,
        AUTH0_CLIENT_ID: props.auth0ClientId,
        AUTH0_CLIENT_SECRET_ARN: auth0Secret.secretArn,
        GITHUB_ISSUE_REPO: props.githubIssueRepo,
        GITHUB_CONNECTION: 'github',
      },
    });
    table.grantReadWriteData(completeFn);
    auth0Secret.grantRead(completeFn);

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(completeFn),
      { prefix: 'videos/', suffix: '.mp4' },
    );

    // ---- Role the Vercel frontend assumes via OIDC (no static keys) ---------
    const issuer = `oidc.vercel.com/${props.vercelTeamSlug}`;
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'VercelOidc',
      `arn:aws:iam::${this.account}:oidc-provider/${issuer}`,
    );
    const frontendRole = new iam.Role(this, 'VercelFrontendRole', {
      description: 'Assumed by the aws-service-heroes Vercel project via OIDC',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { [`${issuer}:aud`]: `https://vercel.com/${props.vercelTeamSlug}` },
        StringLike: {
          [`${issuer}:sub`]: `owner:${props.vercelTeamSlug}:project:${props.vercelProjectName}:environment:*`,
        },
      }),
    });
    bucket.grantReadWrite(frontendRole);
    table.grantReadWriteData(frontendRole);
    frontendRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:StartAsyncInvoke', 'bedrock:GetAsyncInvoke', 'bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/${lumaModelId}`,
          `arn:aws:bedrock:${this.region}:${this.account}:async-invoke/*`,
        ],
      }),
    );
    frontendRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ListAsyncInvokes'],
        resources: ['*'],
      }),
    );

    // ---- Values the frontend needs (copy into Vercel env) -------------------
    new cdk.CfnOutput(this, 'AssetsBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'AssetsCdnDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'HeroesTableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'VercelRoleArn', { value: frontendRole.roleArn });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
  }
}
