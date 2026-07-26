// Live Helm served on :3110 (CF-tunneled) = the hardened websites/Helm build + cards2-ibrain.db (v91).
// Repurposed 2026-07-21: was a 2-var stub; now the full, durable definition of the latest-and-greatest
// engine, moved off the bare :3114 node. The old TGBOTS `helm` app is parked (pm2 stop), not deleted.
module.exports = {
  apps: [
    {
      name: "helm-harness",
      script: "./dist/index.js",
      cwd: "/home/agjrom/websites/Helm",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,       // durability across crashes/reboots (pm2 save + startup)
      watch: false,
      max_memory_restart: "1024M",
      // NOTE: do NOT pm2-restart this while a cards2 cycle is actively running — the engine auto-resumes
      // an active run on boot, which can corrupt an in-flight run against now-dead worker seats. Restart
      // only at a safe boundary (no status='active' run). Fine for UI/viewing anytime.
      env: {
        NODE_ENV: "production",
        HELM_HOST: "0.0.0.0",               // bind all interfaces: reachable on the LAN (192.168.x:3110) AND by the CF tunnel
        HELM_ALLOW_LAN_LAUNCH: "1",         // allow mutating/launch ops from private-LAN clients (not just loopback), so the UI works over the LAN IP. Still owner-cred gated; public IPs always rejected.
        HELM_PORT: "3110",
        HELM_DB_PATH: "/home/agjrom/websites/Helm/data/cards2-ibrain.db",
        HELM_OWNER_CRED: "cards2-harness-563f750bebc23bba", // front-door login; rotate — see report
        HELM_DISABLE_MASTER_SUPERVISOR: "0", // ghost supervisor contaminates repos mid-cycle
        HELM_SKIP_BATCH_DEPLOY: "1",
        HELM_SKIP_REDTEAM: "1",
        HELM_SESSION_JANITOR: "0",
        HELM_CB_WALL_MS: "1800000",
        USE_FAKE_TMUX: "0"
      }
    }
  ]
};
