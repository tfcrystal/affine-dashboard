/**
 * Scheduler script that runs model size updates every 300 seconds
 * This script runs continuously and triggers the update function every 300 seconds
 */

import { updateAllModelSizes } from './update-model-sizes';

// const UPDATE_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours in milliseconds
const UPDATE_INTERVAL_MS = 300 * 1000; // 300 seconds in milliseconds

console.log('====>Model Size Update Scheduler started');
console.log(`====>Update interval: ${UPDATE_INTERVAL_MS / 1000 / 60} minutes (300 seconds)`);
console.log(`====>First update will run immediately, then every 300 seconds`);
  
// Run immediately on startup
updateAllModelSizes()
  .then(() => {
    console.log('====>Initial update completed');
  })
  .catch((error) => {
    console.error('====>Initial update failed:', error);
  });

// Schedule periodic updates
setInterval(() => {
  console.log(`====>Scheduled update triggered at ${new Date().toISOString()}`);
  updateAllModelSizes()
    .then(() => {
      console.log('====>Scheduled update completed');
    })
    .catch((error) => {
      console.error('====>Scheduled update failed:', error);
    });
}, UPDATE_INTERVAL_MS);

// Keep the process alive
console.log('====>Scheduler is running. Press Ctrl+C to stop.');

