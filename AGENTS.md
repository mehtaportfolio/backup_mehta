# Repository Guidelines

## Project Structure & Module Organization
This repository is a Node.js-based automation tool for backing up multiple Supabase/PostgreSQL databases to Google Drive. It is structured as an ES module project.

- **[./backup.js](./backup.js)**: The central entry point. It contains the Express server, API endpoints for manual backup triggers, the backup scheduler (running every 6 hours), and core logic for database dumping (via `pg_dump`), file compression, and Google Drive integration.
- **[./oauth.js](./oauth.js)**: A standalone utility script used to generate a Google OAuth2 refresh token. It runs a temporary local server on port 3000 to handle the OAuth callback.
- **[./public/](./public/)**: Contains static assets (`index.html`, etc.) for a monitoring dashboard served by the main application.
- **[./logs/](./logs/) & [./temp/](./temp/)**: Operational directories used for storing `backup.log` and staging temporary SQL dumps/ZIP files respectively.

## Build, Test, and Development Commands
The project uses standard Node.js commands. Ensure `pg_dump` is installed on the host system as it is invoked via `child_process`.

- **Start the server**: `npm start` (runs `node backup.js`)
- **Generate OAuth tokens**: `node oauth.js`

There are currently no automated test suites or build steps.

## Coding Style & Naming Conventions
- **Module System**: Always use ES Modules (`import`/`export`).
- **Configuration**: All secrets and project configurations must be managed via a [./.env](./.env) file. 
- **Timezone**: The application is configured to use `Asia/Kolkata` for all logging and timestamping.
- **Logic**: 
    - Backups are performed only if the last successful run was more than 3 days ago, unless forced by the absence of a remote backup.
    - The system retains only the last 3 backups on Google Drive per project.

## Commit & Pull Request Guidelines
Follow the existing convention of concise, descriptive commit messages. As the repository currently follows a single-branch initialization pattern, ensure all new features or fixes are documented in commit messages.
