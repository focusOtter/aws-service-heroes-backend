#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsServiceHeroesBackendStack } from '../lib/aws-service-heroes-backend-stack';

const app = new cdk.App();

function ctx(key: string, fallback?: string): string {
  const value = app.node.tryGetContext(key) ?? process.env[key.toUpperCase()] ?? fallback;
  if (!value) throw new Error(`Missing context "${key}" (or env ${key.toUpperCase()})`);
  return value;
}

new AwsServiceHeroesBackendStack(app, 'AwsServiceHeroesBackendStack', {
  // Luma Ray 2 is served from us-west-2.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
  },
  vercelTeamSlug: ctx('vercel_team_slug', 'focus-otters-projects'),
  vercelProjectName: ctx('vercel_project_name', 'aws-service-heroes'),
  auth0Domain: ctx('auth0_domain'),
  auth0ClientId: ctx('auth0_client_id'),
  auth0ClientSecretName: ctx('auth0_client_secret_name', 'aws-service-heroes/auth0-client-secret'),
  githubIssueRepo: ctx('github_issue_repo', 'focusOtter/aws-service-heroes-gallery'),
});
