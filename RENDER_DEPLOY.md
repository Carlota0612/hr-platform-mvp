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

## Add `HR_ENCRYPTION_KEY` to an existing Render service

If the service already exists and is failing with `HR_ENCRYPTION_KEY must be configured in production`, add the variable in the Render dashboard:

1. Open [Render](https://dashboard.render.com/) and sign in.
2. Click your web service, for example `peopleos-hr-platform`.
3. In the left menu, click **Environment**.
4. Click **Add Environment Variable**.
5. Set **Key** to `HR_ENCRYPTION_KEY`.
6. Set **Value** to the `HR_ENCRYPTION_KEY=...` value printed by `npm run generate-secrets`. Paste only the part after `HR_ENCRYPTION_KEY=`.
7. Click **Save Changes**. Render will redeploy the service; if it does not, click **Manual Deploy → Deploy latest commit**.

## Optional invite email variables

User invites work without email by returning a setup link for admins to copy. To email invites automatically through Resend, also set:

- `APP_BASE_URL=https://your-render-service.onrender.com`
- `RESEND_API_KEY=<your Resend API key>`
- `EMAIL_FROM=PeopleOS <noreply@yourdomain.com>`

If these are not configured, the Users page will show the invite link so the admin can copy it manually.

## Node version

The app pins Render to Node `20.x` in `package.json` for stable LTS deployments.
