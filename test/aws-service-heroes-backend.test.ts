import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AwsServiceHeroesBackendStack } from '../lib/aws-service-heroes-backend-stack';

const app = new cdk.App();
const stack = new AwsServiceHeroesBackendStack(app, 'TestStack', {
  env: { account: '111111111111', region: 'us-west-2' },
  vercelTeamSlug: 'team-slug',
  vercelProjectName: 'aws-service-heroes',
  auth0Domain: 'tenant.us.auth0.com',
  auth0ClientId: 'client-id',
  auth0ClientSecretName: 'aws-service-heroes/auth0-client-secret',
  githubIssueRepo: 'owner/gallery',
});
const template = Template.fromStack(stack);

test('table has the byCreatedAt index the gallery queries', () => {
  template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      Match.objectLike({
        IndexName: 'byCreatedAt',
        KeySchema: [
          { AttributeName: 'entity', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      }),
    ],
  });
});

test('bucket is private and served through CloudFront OAC', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
  });
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
});

test('mp4s under videos/ trigger the completion Lambda', () => {
  template.hasResourceProperties('Custom::S3BucketNotifications', {
    NotificationConfiguration: {
      LambdaFunctionConfigurations: [
        Match.objectLike({
          Events: ['s3:ObjectCreated:*'],
          Filter: {
            Key: {
              FilterRules: Match.arrayWith([
                { Name: 'suffix', Value: '.mp4' },
                { Name: 'prefix', Value: 'videos/' },
              ]),
            },
          },
        }),
      ],
    },
  });
});

test('frontend role trusts only the Vercel project via OIDC', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: { 'oidc.vercel.com/team-slug:aud': 'https://vercel.com/team-slug' },
            StringLike: {
              'oidc.vercel.com/team-slug:sub': 'owner:team-slug:project:aws-service-heroes:environment:*',
            },
          },
        }),
      ],
    },
  });
});

test('Auth0 client secret is read from Secrets Manager, not inlined', () => {
  const fns = template.findResources('AWS::Lambda::Function', {
    Properties: { Handler: 'index.handler' },
  });
  const env = Object.values(fns)[0].Properties.Environment.Variables;
  expect(env.AUTH0_CLIENT_SECRET).toBeUndefined();
  expect(env.AUTH0_CLIENT_SECRET_ARN).toBeDefined();
});
