/**
 * Sets up a Windows Task Scheduler job to run the CommonWell automation weekly.
 *
 * Usage:
 *   node setup-scheduler.js
 *   node setup-scheduler.js --day TUE --time 10:00
 *   node setup-scheduler.js --remove
 */

const { execSync } = require('child_process');
const path = require('path');

const TASK_NAME = 'CommonWell_Weekly_Automation';
const SCRIPT_PATH = path.join(__dirname, 'commonwell-login.js');

// Parse command-line arguments
const args = process.argv.slice(2);
const isRemove = args.includes('--remove');

const dayIndex = args.indexOf('--day');
const day = dayIndex !== -1 ? args[dayIndex + 1] : 'MON';

const timeIndex = args.indexOf('--time');
const time = timeIndex !== -1 ? args[timeIndex + 1] : '09:00';

if (isRemove) {
  console.log(`Removing scheduled task: ${TASK_NAME}`);
  try {
    execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: 'inherit' });
    console.log('Task removed successfully.');
  } catch {
    console.error('Failed to remove task. It may not exist.');
  }
  process.exit(0);
}

// Find node.exe path
const nodePath = process.execPath;

console.log('Setting up Windows Task Scheduler job...');
console.log(`  Task name : ${TASK_NAME}`);
console.log(`  Schedule  : Every ${day} at ${time}`);
console.log(`  Script    : ${SCRIPT_PATH}`);
console.log(`  Node      : ${nodePath}`);
console.log('');

const command = [
  'schtasks /create',
  `/tn "${TASK_NAME}"`,
  `/tr "\\"${nodePath}\\" \\"${SCRIPT_PATH}\\""`,
  '/sc weekly',
  `/d ${day}`,
  `/st ${time}`,
  '/f',
].join(' ');

try {
  execSync(command, { stdio: 'inherit' });
  console.log('\nScheduled task created successfully!');
  console.log(`\nTo verify, run: schtasks /query /tn "${TASK_NAME}"`);
  console.log(`To remove,  run: node setup-scheduler.js --remove`);
} catch (error) {
  console.error('\nFailed to create scheduled task.');
  console.error('You may need to run this as Administrator.');
  console.error('Alternatively, create it manually via Task Scheduler (taskschd.msc).');
}
