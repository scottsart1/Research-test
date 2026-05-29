# Job Tracker

A personal job-interview tracker that reads your Gmail inbox via the Anthropic API + Gmail MCP server and renders a live pipeline table.

## Setup

```bash
cd job-tracker
npm install
npm run dev
```

Open http://localhost:5173, paste your **Anthropic API key** (`sk-ant-…`) into the settings bar, and hit Save. The tracker will scan your Gmail inbox and populate the table.

## How it works

1. Your API key is stored in browser `localStorage` only — never sent anywhere except directly to `api.anthropic.com`.
2. The app calls `claude-opus-4-8` with the Gmail MCP server attached. Claude searches your **received** emails, groups threads by company + role, and returns structured JSON.
3. The UI renders the tracker table with stage badges, point-of-contact, last-activity date, and next-action prompts.
4. Use the **Auto-refresh** dropdown to keep the tracker updated throughout the day.

## Gmail MCP Auth

The first time you hit Refresh the Anthropic API will redirect through Google OAuth to authorise Gmail read access. Follow the prompts — Claude only reads emails, never sends or deletes.

## Stages

| Stage | Meaning |
|---|---|
| General Conversation | Early/informal recruiter chat |
| Recruiter Outreach | Inbound recruiter email |
| Applied | Confirmed application receipt |
| Awaiting Response | Sent something, waiting to hear back |
| Screening | Phone/video screen scheduled or done |
| Interview Scheduled | Formal interview confirmed |
| Technical/Take-home | Assignment in progress or submitted |
| Final/Onsite | Final round |
| Offer | Offer extended |
| Rejected | Process ended |
