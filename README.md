# ReachInbox — Email Job Scheduler

A full-stack email scheduling application that lets users schedule email campaigns, control sending rates, track email status, and receive Slack notifications when hourly limits are reached.

## Features

- **Authentication:** Firebase Google sign-in.
- **Email scheduling:** Schedule emails for future delivery.
- **Queue processing:** BullMQ and Redis handle delayed jobs and background processing.
- **Persistent storage:** PostgreSQL stores email records and statuses.
- **Rate limiting:** Configurable hourly sending limits and minimum delay between emails.
- **Email delivery:** Nodemailer with Ethereal SMTP for testing.
- **Search:** Elasticsearch indexing for email records.
- **Queue monitoring:** Bull Board dashboard for job inspection.
- **Slack notifications:** Alerts when an hourly sending limit is reached.
- **Frontend:** React, TypeScript, Vite, and CSS.

## Technology Stack

| Component | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| Backend | Node.js, Express, TypeScript |
| Authentication | Firebase Authentication |
| Database | PostgreSQL |
| Queue and delayed jobs | BullMQ, Redis |
| Email testing | Nodemailer, Ethereal Email |
| Search indexing | Elasticsearch |
| Queue dashboard | Bull Board |
| Notifications | Slack API |
| Local services | Docker Compose |

## Project Structure

```text
reachinbox-scheduler/
├── backend/
│   ├── src/
│   │   ├── db.ts               # PostgreSQL database and schema
│   │   ├── elasticsearch.ts    # Elasticsearch connection and indexing
│   │   ├── queue.ts            # BullMQ queue configuration
│   │   ├── search.ts           # Email search functionality
│   │   ├── server.ts           # Express API and routes
│   │   ├── slack.ts            # Slack notifications
│   │   └── worker.ts           # Background email processing
│   ├── dist/                   # Compiled backend output
│   ├── .env                    # Private environment variables (not committed)
│   ├── .gitignore
│   ├── .dockerignore
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── server.js               # Legacy backend file; verify whether still needed
│   ├── reachinbox.db           # Legacy SQLite database; not committed
│   └── serviceAccountKey.json  # Firebase credentials (not committed)
├── frontend/
│   ├── src/
│   │   ├── assets/
│   │   ├── App.tsx             # Main application and dashboard
│   │   ├── App.css             # Dashboard and application styles
│   │   ├── firebase.ts         # Firebase configuration
│   │   ├── index.css           # Global styles
│   │   └── main.tsx            # Frontend entry point
│   ├── public/
│   ├── index.html
│   ├── package.json
│   ├── package-lock.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   ├── .gitignore
│   └── README.md
├── docker-compose.yml
├── .gitignore
└── README.md
```

## Prerequisites

- Node.js and npm
- Docker Desktop
- Firebase project configured for Google sign-in
- Slack app configured for notifications
- Ethereal Email SMTP credentials

## Setup

### 1. Start the supporting services

From the project root, run:

```powershell
docker compose up -d
```

Ensure PostgreSQL, Redis, and Elasticsearch are running.

### 2. Configure the backend

Create or update `backend/.env` using your own local credentials. Configure the database connection, Redis, SMTP, Elasticsearch, Firebase Admin credentials, worker concurrency, sending limits, and Slack settings.

Never commit `.env` or Firebase service-account private keys.

### 3. Install and run the backend

```powershell
cd backend
npm.cmd install
npm.cmd run build
npm.cmd run dev
```

The API runs at `http://localhost:5000`.

### 4. Run the frontend

Open a second terminal:

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:5173`.

### 5. Monitor the queue

Open `http://localhost:5000/admin/queues/queue/reachinbox-emails` to inspect queued, delayed, completed, and failed jobs.

### 6. Verify email delivery

Use Ethereal Email to inspect test messages. Ethereal is a testing service and does not deliver messages to real recipients' inboxes.

## Rate Limiting and Reliability

The application uses Redis-backed rate-limit tracking and BullMQ delayed jobs to defer emails when the configured hourly limit is reached. Email records are stored in PostgreSQL, and Elasticsearch maintains searchable email documents.

Verify persistence by restarting the application while keeping PostgreSQL and Redis running. Confirm that existing records and pending jobs remain available.

## Development and Testing

Build the backend:

```powershell
cd backend
npm.cmd run build
```

Build the frontend:

```powershell
cd frontend
npm.cmd run build
```

Test scheduling with multiple recipients and a low hourly limit. Confirm that jobs are delayed rather than discarded and that Slack notifications are generated.

## Limitations

This project uses Ethereal SMTP for testing. Real email delivery requires a production SMTP provider or email service. Production deployment also requires securely configured credentials, HTTPS, and appropriate access controls for administrative dashboards.

## License

Add the license required by your project or assignment.
