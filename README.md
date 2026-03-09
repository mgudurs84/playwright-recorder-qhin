# CommonWell Automation

Automated login to the CommonWell Management Portal with manual OTP support and session reuse.

## Setup

```bash
cd commonwell-automation

# 1. Install dependencies
npm install

# 2. Install Playwright browsers
npx playwright install chromium

# 3. Create your .env file with credentials
copy .env.example .env
# Edit .env and fill in your actual username and password
```

## Run Manually

```bash
npm start
```

The script will:
1. Check for a valid saved session
2. If session is valid → skip login, run tasks directly
3. If session is expired → open browser, fill credentials, prompt you for OTP
4. Save the session for next time
5. Run your automation tasks

## Schedule Weekly

```bash
# Schedule for every Monday at 9 AM (default)
node setup-scheduler.js

# Custom day and time
node setup-scheduler.js --day WED --time 14:00

# Remove the scheduled task
node setup-scheduler.js --remove
```

## Project Structure

```
commonwell-automation/
├── commonwell-login.js     # Main automation script
├── setup-scheduler.js      # Windows Task Scheduler setup
├── package.json
├── .env.example            # Template for credentials
├── .env                    # Your actual credentials (git-ignored)
├── .gitignore
└── commonwell-session.json # Saved session (git-ignored, auto-generated)
```

## Adding Automation Tasks

Edit the `runAutomationTasks()` function in `commonwell-login.js` to add your weekly tasks (navigate pages, download reports, fill forms, etc.).
