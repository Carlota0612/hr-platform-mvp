# PeopleOS HR Platform MVP

A small deployable HR platform for teams, employees, achievements, career progression, talent action plans, talent development plans, people directory, and org chart.

## Local run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Default login:

- Email: `admin@example.com`
- Password: `admin123`

Change these in Render environment variables before using real data. Keep `HR_ENCRYPTION_KEY` stable after launch because it is used to decrypt private HR fields.

## Deploy on Render

1. Create a GitHub repository and upload these files.
2. In Render, click **New > Web Service** and connect the repository.
3. Use:
   - Build command: `npm install`
   - Start command: `npm start`
4. Add environment variables:
   - `NODE_ENV=production`
   - `SESSION_SECRET=<a long random value>`
   - `HR_ENCRYPTION_KEY=<a long random value>`
   - `ADMIN_EMAIL=<your admin email>`
   - `ADMIN_PASSWORD=<your strong password>`
5. Deploy.

Render's official Node/Express quickstart uses a Node web service with a build command and a start command, and the app must listen on `process.env.PORT`.

## Important notes

This MVP uses SQLite. On Render free web services, local filesystem data may not be durable across redeploys unless you configure persistent storage or move to a managed database. For real employee data, use PostgreSQL, Supabase, Neon, or Render PostgreSQL, and add proper security, audit logs, GDPR retention rules, and access controls.

## Features

- Login/logout
- Dashboard
- Teams CRUD
- Employees CRUD
- Achievements CRUD
- Career progression CRUD
- Talent action plans CRUD
- Talent development plans CRUD
- Searchable people directory
- Org chart from manager relationships
- Basic generated talent memo from stored records

