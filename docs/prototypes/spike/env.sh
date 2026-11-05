# Strip the parent Claude Code session variables so child workers look like a fresh host launch.
export SP="${SCRATCH:?Set SCRATCH to a scratch folder}/spike"
for v in $(env | grep -E '^(CLAUDE|AI_AGENT)' | cut -d= -f1); do unset $v; done
ISO=(--setting-sources "" --strict-mcp-config --disable-slash-commands --model haiku --no-chrome)
