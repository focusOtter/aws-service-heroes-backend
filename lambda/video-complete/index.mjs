// Fires when Bedrock (Luma Ray 2) writes videos/<heroId>/<invocation>/output.mp4.
// Marks the hero record complete, then patches its GitHub issue with the video
// link using the user's stored Auth0 refresh token (Token Vault exchange) —
// no GitHub PAT anywhere.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sm = new SecretsManagerClient({})

const {
  HEROES_TABLE_NAME,
  ASSETS_CDN_DOMAIN,
  AUTH0_DOMAIN,
  AUTH0_CLIENT_ID,
  AUTH0_CLIENT_SECRET_ARN,
  GITHUB_ISSUE_REPO,
  GITHUB_CONNECTION = 'github',
} = process.env

let cachedSecret
async function clientSecret() {
  if (!cachedSecret) {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: AUTH0_CLIENT_SECRET_ARN }))
    cachedSecret = res.SecretString
  }
  return cachedSecret
}

export function heroIdFromKey(key) {
  const parts = key.split('/')
  if (parts[0] !== 'videos' || parts.length < 3 || !key.endsWith('.mp4')) return null
  return parts[1] || null
}

export async function exchangeForGithubToken(refreshToken, fetchImpl = fetch) {
  const res = await fetchImpl(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: AUTH0_CLIENT_ID,
      client_secret: await clientSecret(),
      subject_token: refreshToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
      grant_type: 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
      requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
      connection: GITHUB_CONNECTION,
    }),
  })
  if (!res.ok) throw new Error(`token_exchange_failed status=${res.status}`)
  const json = await res.json()
  return json.access_token
}

export function withVideoLink(body, videoUrl) {
  const link = `🎬 [Animated version](${videoUrl})`
  if (body.includes(link)) return null
  if (/_Animation pending[^_]*_/.test(body)) return body.replace(/_Animation pending[^_]*_/, link)
  return `${body}\n\n${link}`
}

async function patchIssue(issueNumber, refreshToken, videoUrl) {
  const token = await exchangeForGithubToken(refreshToken)
  const url = `https://api.github.com/repos/${GITHUB_ISSUE_REPO}/issues/${issueNumber}`
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'aws-service-heroes-video-complete',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const read = await fetch(url, { headers })
  if (!read.ok) throw new Error(`issue_read_failed status=${read.status}`)
  const current = await read.json()
  const next = withVideoLink(String(current.body ?? ''), videoUrl)
  if (next === null) return
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: next }),
  })
  if (!res.ok) throw new Error(`issue_patch_failed status=${res.status}`)
}

export async function handler(event) {
  for (const record of event.Records ?? []) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '))
    const id = heroIdFromKey(key)
    if (!id) continue

    const { Item: hero } = await ddb.send(new GetCommand({ TableName: HEROES_TABLE_NAME, Key: { id } }))
    if (!hero) {
      console.warn(`[video-complete] no hero record for ${id}`)
      continue
    }

    await ddb.send(
      new UpdateCommand({
        TableName: HEROES_TABLE_NAME,
        Key: { id },
        UpdateExpression: 'SET #s = :s, videoKey = :k',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'complete', ':k': key },
      }),
    )

    if (hero.issueNumber && hero.refreshToken) {
      try {
        await patchIssue(hero.issueNumber, hero.refreshToken, `https://${ASSETS_CDN_DOMAIN}/${key}`)
        console.log(`[video-complete] ${id}: patched issue #${hero.issueNumber}`)
      } catch (err) {
        // The video is still in the gallery; only the issue link is missing.
        console.error(`[video-complete] ${id}: ${err instanceof Error ? err.message : err}`)
      }
    }
  }
}
