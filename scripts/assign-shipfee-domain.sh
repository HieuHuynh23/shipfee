#!/usr/bin/env bash
# Assign https://shipfee.vercel.app to the latest Production deployment.
# Requires: VERCEL_TOKEN (https://vercel.com/account/tokens)
# Optional: VERCEL_SCOPE (default: hieuhuynh234s-projects)
set -euo pipefail

SCOPE="${VERCEL_SCOPE:-hieuhuynh234s-projects}"
ALIAS="${VERCEL_ALIAS:-shipfee.vercel.app}"

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "ERROR: VERCEL_TOKEN is required."
  echo "Create one at https://vercel.com/account/tokens then:"
  echo "  export VERCEL_TOKEN=..."
  echo "  bash scripts/assign-shipfee-domain.sh"
  exit 1
fi

echo "→ Installing Vercel CLI..."
npx --yes vercel@39 --version >/dev/null

echo "→ Looking up latest Production deployment for scope=${SCOPE}..."
# List recent deployments for the shipfee project and pick a READY production one
DEPLOY_URL="$(
  npx --yes vercel@39 ls shipfee --token "$VERCEL_TOKEN" --scope "$SCOPE" 2>/dev/null \
    | awk '/https:\/\/shipfee-.*\.vercel\.app/ { print $1; exit }'
)"

if [[ -z "${DEPLOY_URL}" ]]; then
  # Fallback: use Vercel REST API
  echo "→ CLI list empty, trying REST API..."
  DEPLOY_URL="$(
    curl -sS -H "Authorization: Bearer ${VERCEL_TOKEN}" \
      "https://api.vercel.com/v6/deployments?app=shipfee&target=production&limit=5&teamId=${SCOPE}" \
      | node -e '
        let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
          const j=JSON.parse(d);
          const item=(j.deployments||[]).find(x => x.state==="READY" || x.readyState==="READY") || (j.deployments||[])[0];
          if(!item){ process.exit(2); }
          const url = item.url ? ("https://" + item.url.replace(/^https?:\/\//,"")) : "";
          process.stdout.write(url);
        });
      '
  )"
fi

if [[ -z "${DEPLOY_URL}" ]]; then
  echo "ERROR: Could not find a Production deployment for project shipfee."
  exit 1
fi

echo "→ Assigning alias ${ALIAS} → ${DEPLOY_URL}"
npx --yes vercel@39 alias set "$DEPLOY_URL" "$ALIAS" --token "$VERCEL_TOKEN" --scope "$SCOPE"

echo "→ Verifying https://${ALIAS}/ ..."
CODE="$(curl -sS -o /tmp/shipfee-alias-check.body -w "%{http_code}" "https://${ALIAS}/" || true)"
echo "HTTP ${CODE}"
if [[ "$CODE" == "404" ]] && grep -q DEPLOYMENT_NOT_FOUND /tmp/shipfee-alias-check.body 2>/dev/null; then
  echo "WARN: Alias still returns DEPLOYMENT_NOT_FOUND. Wait 30–60s for edge propagation, or add the domain in:"
  echo "  https://vercel.com/${SCOPE}/shipfee/settings/domains"
  exit 2
fi

echo "OK: https://${ALIAS}/ should now serve the production frontend."
echo "If you still get Vercel SSO / login wall, disable Deployment Protection:"
echo "  https://vercel.com/${SCOPE}/shipfee/settings/deployment-protection"
