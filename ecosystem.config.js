module.exports = {
  apps: [
    {
      name: 'dominated-web',
      // Next.js requires a production build in `.next/` before `next start`.
      // PM2 restarts can happen after reboots/deploys, so we ensure build then start.
      script: '/usr/bin/bash',
      // Use array form to avoid quoting issues in PM2.
      args: ['-lc', 'npm run build && PORT=3568 ./node_modules/.bin/next start -p 3568'],
      cwd: '/root/bittensor/affine-cortex',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3568,
        CHUTES_API_KEY: process.env.CHUTES_API_KEY || ''
      }
    },
    {
      name: 'model-size-scheduler',
      // Scheduler that updates model sizes every 3 hours
      script: 'npm',
      args: ['run', 'schedule-model-sizes'],
      cwd: 'root/bittensor/affine-cortex/dominated-web',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
