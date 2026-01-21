module.exports = {
  apps: [
    {
      name: 'product-web',
      // Next.js requires a production build in `.next/` before `next start`.
      // PM2 restarts can happen after reboots/deploys, so we ensure build then start.
      script: '/usr/bin/bash',
      // Use array form to avoid quoting issues in PM2.
      args: ['-lc', 'npm run build && npm start'],
      cwd: '/root/bittensor/affine-cortex/product-web',
      instances: 1,
      autorestart: false,
      watch: false,
      // max_memory_restart: '1G', // Disabled to prevent automatic restarts
      env: {
        NODE_ENV: 'production',
        PORT: 3568,
        CHUTES_API_KEY: process.env.CHUTES_API_KEY || ''
      }
    },
    {
      name: 'model-size-scheduler',
      // Scheduler that updates model sizes every 3 hours
      script: '/root/bittensor/affine-cortex/product-web/node_modules/.bin/tsx',
      args: ['scripts/schedule-model-size-updates.ts'],
      cwd: '/root/bittensor/affine-cortex/product-web',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
