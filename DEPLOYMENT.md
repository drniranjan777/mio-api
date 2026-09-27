# Deploying Mio Doctors on a Hostinger Ubuntu VPS

| What | Where |
|---|---|
| API (Node.js + MongoDB) | **https://api.miodoctors.com** → `https://api.miodoctors.com/api/v1` |
| Admin panel (React build) | **https://admin.miodoctors.com** |
| Server | Hostinger KVM VPS, **Ubuntu 24.04 LTS** (22.04 works too — see notes) |
| Code | GitHub (private): `drniranjan777/mio-api` → `/var/www/miodoctors/backend`, `drniranjan777/mio-admin` → `/var/www/miodoctors/admin` |

Everything runs on one VPS: Nginx (HTTPS, reverse proxy) → Node API on `127.0.0.1:4000` → MongoDB on `127.0.0.1:27017`. Only ports 22, 80 and 443 are open.

> **Use `https://` for both.** The API carries login tokens and OTPs; plain `http://api…` must never be used. Step 8 gets free Let's Encrypt certificates and redirects HTTP → HTTPS automatically.

---

## Before you go live — two things only you can provide

| Feature | State today | On the live server until added |
|---|---|---|
| **SMS for OTP** (doctor / MR / receptionist sign-in) | Only a development provider exists | App sign-in answers *"Sign-in by SMS is not available yet"*. The **admin panel works fully**. |
| **Online payments** (MR plans) | Only a mock provider exists | `PAYMENTS_ENABLED=false`: checkout says *"Online payments are not available yet"*; the free doctor plan still works. |

To open the app to real users, choose an SMS gateway (e.g. **MSG91** — needs DLT registration of your sender ID and OTP template in India) and a payment gateway (e.g. **Razorpay**). Share the API keys securely and they plug in behind `sms.provider.js` / `payment.provider.js` without other changes.

---

## Step 1 — Create the VPS (Hostinger hPanel)

1. hPanel → **VPS** → choose your plan → **Operating System**: *Ubuntu 24.04* (plain OS, no panel).
2. Set a strong root password and, better, **add your SSH public key** (hPanel → VPS → *Settings* → *SSH keys*).
   No key yet? On your Windows PC (PowerShell): `ssh-keygen -t ed25519` → copy the text of `C:\Users\<you>\.ssh\id_ed25519.pub` into hPanel.
3. Note the VPS **public IPv4 address** (and IPv6 if shown).
4. If you enable Hostinger's own firewall (hPanel → VPS → *Firewall*), allow **TCP 22, 80, 443**.

## Step 2 — Point the subdomains to the VPS (DNS)

Where `miodoctors.com` is managed (hPanel → **Domains** → *miodoctors.com* → **DNS / Nameservers**), add:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `api` | *VPS IPv4* | 300 |
| A | `admin` | *VPS IPv4* | 300 |
| AAAA *(optional)* | `api` / `admin` | *VPS IPv6* | 300 |

Check from your PC (wait 5–30 minutes): `nslookup api.miodoctors.com` and `nslookup admin.miodoctors.com` must show the VPS IP. **Certificates in step 8 fail until this works.**

## Step 3 — First login and server hardening

From your PC:

```bash
ssh root@YOUR_VPS_IP
```

On the server (as root):

```bash
# Updates + basic tools
apt update && apt -y full-upgrade
apt -y install curl git ufw fail2ban unattended-upgrades ca-certificates gnupg
timedatectl set-timezone Asia/Kolkata

# A normal user for deployments (you log in as this from now on)
adduser deploy                       # choose a strong password
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # copies your SSH key

# Firewall: only SSH + web
ufw allow OpenSSH
ufw allow 'Nginx Full' 2>/dev/null || { ufw allow 80/tcp; ufw allow 443/tcp; }
ufw --force enable

# Automatic security updates + brute-force protection
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban
```

**Test in a second window** that `ssh deploy@YOUR_VPS_IP` works. Then turn off root and password logins:

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

(Skip the `PasswordAuthentication no` part if you did not set up an SSH key.)

## Step 4 — Install Node.js 24, Nginx, PM2 and Certbot

Log in as **deploy** from now on: `ssh deploy@YOUR_VPS_IP`

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt -y install nodejs nginx certbot python3-certbot-nginx
sudo npm install -g pm2
node -v    # v24.x
```

## Step 5 — Install MongoDB 8 (local, password-protected)

```bash
# MongoDB 8 needs a CPU with AVX — Hostinger KVM plans have it. Check:
grep -m1 -o avx /proc/cpuinfo || echo "NO AVX: use MongoDB Atlas instead (see notes)"

curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(. /etc/os-release; echo $VERSION_CODENAME)/mongodb-org/8.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update && sudo apt -y install mongodb-org
sudo systemctl enable --now mongod
```

Create two database users (replace both passwords — use `openssl rand -hex 24` to generate them, and keep them safe):

```bash
mongosh --quiet <<'JS'
use admin
db.createUser({ user: "mongoAdmin", pwd: "REPLACE_ADMIN_PASSWORD", roles: ["root"] })
use mio_doctors
db.createUser({ user: "mio_app", pwd: "REPLACE_APP_PASSWORD", roles: [{ role: "readWrite", db: "mio_doctors" }] })
JS
```

Turn on authentication (MongoDB already listens on `127.0.0.1` only):

```bash
sudo tee -a /etc/mongod.conf >/dev/null <<'EOF'
security:
  authorization: enabled
EOF
sudo systemctl restart mongod
mongosh "mongodb://mio_app:REPLACE_APP_PASSWORD@127.0.0.1:27017/mio_doctors?authSource=mio_doctors" --eval 'db.runCommand({ping:1})'
```

The last command must print `{ ok: 1 }`.

## Step 6 — Get the code from GitHub (read-only deploy keys)

The repositories are private, so the server gets its own **read-only** key per repository (no personal password or token on the server).

On the server:

```bash
ssh-keygen -t ed25519 -N "" -C "vps mio-api"   -f ~/.ssh/mio_api
ssh-keygen -t ed25519 -N "" -C "vps mio-admin" -f ~/.ssh/mio_admin
cat >> ~/.ssh/config <<'EOF'
Host github-mio-api
  HostName github.com
  User git
  IdentityFile ~/.ssh/mio_api
  IdentitiesOnly yes
Host github-mio-admin
  HostName github.com
  User git
  IdentityFile ~/.ssh/mio_admin
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
cat ~/.ssh/mio_api.pub      # copy → GitHub mio-api   → Settings → Deploy keys → Add (leave "write" OFF)
cat ~/.ssh/mio_admin.pub    # copy → GitHub mio-admin → Settings → Deploy keys → Add (leave "write" OFF)
```

Then clone:

```bash
sudo mkdir -p /var/www/miodoctors /var/log/miodoctors
sudo chown -R deploy:deploy /var/www/miodoctors /var/log/miodoctors
git clone git@github-mio-api:drniranjan777/mio-api.git     /var/www/miodoctors/backend
git clone git@github-mio-admin:drniranjan777/mio-admin.git /var/www/miodoctors/admin
ls /var/www/miodoctors      # admin  backend
```

(Answer `yes` the first time SSH asks to trust github.com.)

## Step 7 — Configure and start the API

```bash
cd /var/www/miodoctors/backend
cp deploy/backend.env.production.example .env
chmod 600 .env
openssl rand -hex 48      # run twice: one value for JWT_ACCESS_SECRET, one for OTP_PEPPER
nano .env
```

In `.env` fill in:

- `MONGODB_URI` → the `mio_app` password from step 5
- `JWT_ACCESS_SECRET`, `OTP_PEPPER` → the two random values
- `SEED_ADMIN_EMAIL` → your admin email; `SEED_ADMIN_PASSWORD` → **at least 12 characters** (production rule)

Install, build and start everything:

```bash
bash /var/www/miodoctors/backend/deploy/deploy.sh   # pulls, installs deps, builds admin, starts API, health check
cd /var/www/miodoctors/backend && npm run seed  # first admin + plans, FAQs, terms, admin roles
```

Do **not** run `npm run seed:demo` on the live server (it creates demo doctors and appointments).

After the seed, remove the password from the file: `nano .env` → delete the value of `SEED_ADMIN_PASSWORD` (to change it later use `npm run admin:password`).

Make the API start on reboot:

```bash
pm2 startup systemd -u deploy --hp /home/deploy    # copy-paste the sudo command it prints
pm2 save
pm2 install pm2-logrotate                           # keeps log files small
```

## Step 8 — Nginx + free HTTPS certificates

```bash
sudo cp /var/www/miodoctors/backend/deploy/nginx/api.miodoctors.com.conf   /etc/nginx/sites-available/
sudo cp /var/www/miodoctors/backend/deploy/nginx/admin.miodoctors.com.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/api.miodoctors.com.conf   /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/admin.miodoctors.com.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo sed -i 's/# server_tokens off;/server_tokens off;/' /etc/nginx/nginx.conf
sudo nginx -t && sudo systemctl reload nginx

# Certificates + automatic HTTP → HTTPS redirect (answers: your email, agree, redirect)
sudo certbot --nginx -d api.miodoctors.com -d admin.miodoctors.com --redirect
sudo certbot renew --dry-run      # auto-renewal check
```

## Step 9 — Check it works

From your PC:

```bash
curl https://api.miodoctors.com/api/v1/health
```

→ `{"success":true,"data":{"status":"ok"}}`

- Open **https://admin.miodoctors.com** → sign in with the `SEED_ADMIN_EMAIL` and password from step 7.
- `curl http://api.miodoctors.com/api/v1/health` should redirect (301) to HTTPS.
- From outside, port 4000 and 27017 must **not** answer (only Nginx is public).

Once HTTPS works everywhere, you can add HSTS: in both `/etc/nginx/sites-available/*.conf` HTTPS blocks add
`add_header Strict-Transport-Security "max-age=31536000" always;` then `sudo nginx -t && sudo systemctl reload nginx`.

## Step 10 — Point the mobile app at the live API

On your PC, in the Flutter project (`mioapp` repository):

```bash
flutter build apk --release --dart-define=API_BASE_URL=https://api.miodoctors.com/api/v1
```

The APK is in `build\app\outputs\flutter-apk\app-release.apk`. For the Play Store you also need a release signing key (the current build uses the debug key) and `flutter build appbundle` with the same `--dart-define`.

## Step 11 — Daily database backup

```bash
sudo apt -y install mongodb-database-tools
chmod +x /var/www/miodoctors/backend/deploy/backup-mongo.sh
sudo mkdir -p /var/backups/miodoctors && sudo chown deploy:deploy /var/backups/miodoctors
/var/www/miodoctors/backend/deploy/backup-mongo.sh && ls -lh /var/backups/miodoctors   # test once
crontab -e     # add this line:
# 30 2 * * * /var/www/miodoctors/backend/deploy/backup-mongo.sh
```

Backups stay 14 days on the server. Also copy them off the server regularly (e.g. download with `scp`, or Hostinger's VPS snapshots in hPanel). Restore: `mongorestore --uri="<MONGODB_URI>" --archive=FILE.gz --gzip --drop`.

---

## Updating to a new version

1. Push your changes to `mio-api` / `mio-admin` on GitHub (branch `main`).
2. On the server:

```bash
bash /var/www/miodoctors/backend/deploy/deploy.sh
```

It pulls both repositories, installs, rebuilds the admin panel and restarts the API. `.env` and the database are not touched (`.env` is never in Git).

## Everyday commands

| Task | Command |
|---|---|
| API status / logs | `pm2 status` · `pm2 logs mio-api --lines 100` |
| Restart API | `pm2 restart mio-api` |
| Nginx logs | `sudo tail -f /var/log/nginx/api.miodoctors.error.log` |
| MongoDB status | `sudo systemctl status mongod` |
| Certificates | `sudo certbot certificates` |
| Reset the owner admin password | edit `SEED_ADMIN_*` in `.env` → `npm run admin:password` → clear the password again |

## Notes

- **Ubuntu 22.04:** identical steps; the MongoDB repo line picks `jammy` automatically.
- **No AVX / prefer managed DB:** create a free/paid cluster on MongoDB Atlas, allow only the VPS IP, and put its `mongodb+srv://…` URI in `MONGODB_URI`; skip step 5 and step 11 (Atlas has backups).
- **Optional extra protection for the admin panel:** restrict it to your office IPs by adding `allow 1.2.3.4; deny all;` inside the `location /` block of `admin.miodoctors.com.conf`.
- **Secrets:** `.env` is readable only by the `deploy` user (`chmod 600`). Never commit it or paste it in chat/email.
