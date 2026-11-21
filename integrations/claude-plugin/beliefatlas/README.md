# BeliefAtlas plugin for Claude (switched off, not published)

What's here: the plugin's manifest and its skill. The server it points at is BeliefAtlas's own
`/api/mcp` (lib/ai-head), off unless `AI_HEAD_ENABLED=true`. Design: belief-map/claude-plugin.md.

There is no `.mcp.json` on purpose: its address is the real domain, which isn't chosen yet, and
nothing goes out before the domain. `npm run plugin:build` writes a ready copy to
`dist/claude-plugin/beliefatlas/` once `PUBLIC_BASE_URL` is set; `npm run plugin:build -- --local`
writes one pointed at `http://localhost:3000` for trying in Claude Code on your own machine:

    AI_HEAD_ENABLED=true npm run dev
    npm run plugin:build -- --local
    claude --plugin-dir dist/claude-plugin/beliefatlas

Don't submit it to a directory or marketplace, or upload it to an account, until Sean says so.
The plugin holds no secrets: each person links their own BeliefAtlas account when they connect.
