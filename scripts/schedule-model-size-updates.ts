/**
 * Scheduler script that runs model size updates every 300 seconds
 * This script runs continuously and triggers the update function every 300 seconds
 */

import { updateAllModelSizes } from './update-model-sizes';

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
// const UPDATE_INTERVAL_MS = 300 * 1000; // 300 seconds in milliseconds

// Helper to ensure output is flushed immediately
function log(message: string) {
  console.log(message);
  process.stdout.write(''); // Force flush
}

function logError(message: string, error?: any) {
  console.error(message, error || '');
  process.stderr.write(''); // Force flush
}

log('====>Model Size Update Scheduler started');
log(`====>Update interval: ${UPDATE_INTERVAL_MS / 1000 / 60} minutes (6 hours)`);
log(`====>First update will run immediately, then every 6 hours`);
log(`====>Process PID: ${process.pid}`);
log(`====>Scheduler is running. Press Ctrl+C to stop.`);

// Handle uncaught errors to prevent process exit
process.on('uncaughtException', (error) => {
  logError('====>Uncaught exception:', error);
  // Don't exit - keep the scheduler running
});

process.on('unhandledRejection', (reason, promise) => {
  logError('====>Unhandled rejection at:', promise);
  logError('====>Reason:', reason);
  // Don't exit - keep the scheduler running
});

// Run immediately on startup
updateAllModelSizes()
  .then(() => {
    log('====>Initial update completed');
  })
  .catch((error) => {
    logError('====>Initial update failed:', error);
  });

// Schedule periodic updates
const intervalId = setInterval(() => {
  log(`====>Scheduled update triggered at ${new Date().toISOString()}`);
  updateAllModelSizes()
    .then(() => {
      log('====>Scheduled update completed');
    })
    .catch((error) => {
      logError('====>Scheduled update failed:', error);
    });
}, UPDATE_INTERVAL_MS);

// Keep the process alive and handle graceful shutdown
process.on('SIGINT', () => {
  log('====>Received SIGINT, shutting down gracefully...');
  clearInterval(intervalId);
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('====>Received SIGTERM, shutting down gracefully...');
  clearInterval(intervalId);
  process.exit(0);
});

