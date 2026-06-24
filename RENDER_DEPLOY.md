# Render deployment settings

This app intentionally refuses to start in production unless the security secrets are configured.

## Required environment variables

Add these in **Render Dashboard → your service → Environment**:

- `NODE_ENV=production`
- `SESSION_SECRET=<random secret>`
- `HR_ENCRYPTION_KEY=<random secret>`
- `ADMIN_EMAIL=<your admin email>`
- `ADMIN_PASSWORD=<strong initial admin password>`

Generate fresh secret values locally with:

```bash
npm run generate-secrets
```

Copy the printed values into Render. Keep `HR_ENCRYPTION_KEY` stable after launch. It encrypts HR private data; changing it later means previously encrypted HR data cannot be decrypted.

## Optional invite email variables

User invites work without email by returning a setup link for admins to copy. To email invites automatically through Resend, also set:

- `APP_BASE_URL=https://your-render-service.onrender.com`
- `RESEND_API_KEY=<your Resend API key>`
- `EMAIL_FROM=PeopleOS <noreply@yourdomain.com>`

If these are not configured, the Users page will show the invite link so the admin can copy it manually.

## Node version

The app pins Render to Node `20.x` in `package.json` for stable LTS deployments.
