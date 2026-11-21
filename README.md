# AWS Service Heroes — backend

CDK stack behind [aws-service-heroes](https://github.com/focusOtter/aws-service-heroes), the booth app that turns a selfie into an AWS-service hero and files it as a GitHub issue through Auth0 Token Vault.

```
Vercel (Next.js) ──OIDC──▶ VercelFrontendRole ──▶ S3 assets ◀── CloudFront (OAC)
        │                                      ├─▶ DynamoDB heroes (GSI byCreatedAt)
        │                                      └─▶ Bedrock Luma Ray 2 (async, optional)
        │                                                   │ writes videos/<id>/…/output.mp4
        └── Auth0 Token Vault (GitHub)                      ▼
                     ▲                         S3 ObjectCreated ─▶ VideoCompleteFn (Lambda)
                     └──── refresh token → GitHub token exchange ── patches the issue with the video link
```

## What it creates (us-west-2)

| Resource | Purpose |
| --- | --- |
| `AssetsBucket` + `AssetsCdn` | Private bucket for selfies, stills and mp4s, served by CloudFront with Origin Access Control |
| `HeroesTable` | One record per hero; `byCreatedAt` GSI (`entity`/`createdAt`) feeds the gallery |
| `VideoCompleteFn` | On `videos/**.mp4`, marks the record complete and patches the GitHub issue via a Token Vault federated-token exchange (no PAT) |
| `VercelFrontendRole` | Assumed by the Vercel project through the team's OIDC provider; S3, DynamoDB and Bedrock async-invoke only |

## Deploy

Prerequisites: the account is CDK-bootstrapped in us-west-2, the Vercel team OIDC provider `oidc.vercel.com/<team-slug>` exists in IAM, and the Auth0 client secret is stored in Secrets Manager:

```bash
aws secretsmanager create-secret --region us-west-2 \
  --name aws-service-heroes/auth0-client-secret --secret-string '<auth0 client secret>'

npm ci
npm test
npx cdk deploy -c auth0_domain=<tenant>.us.auth0.com -c auth0_client_id=<client id>
```

Optional context: `vercel_team_slug` (default `focus-otters-projects`), `vercel_project_name` (`aws-service-heroes`), `github_issue_repo` (`focusOtter/aws-service-heroes-gallery`), `auth0_client_secret_name`.

Copy the stack outputs into the frontend's Vercel env: `AssetsBucketName` → `ASSETS_BUCKET_NAME`, `AssetsCdnDomain` → `ASSETS_CDN_DOMAIN`, `HeroesTableName` → `HEROES_TABLE_NAME`, `VercelRoleArn` → `AWS_ROLE_ARN`, `Region` → `AWS_REGION`.

## Video

Luma Ray 2 is billed per second of output and needs the AWS Marketplace offer accepted in the account. The frontend only starts videos when `VIDEO_ENABLED=true`; with it off, the stack still deploys and the completion Lambda simply never fires.
