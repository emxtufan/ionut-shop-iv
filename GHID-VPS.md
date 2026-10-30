# Ce am de făcut: mutare pe VPS și lansare

Comenzile sunt pentru Ubuntu 24.04 și nu au fost testate încă pe un VPS.

## 1. Pe calculatorul local

- [ ] Opresc serverul, rulez `npm run db:migrate` și `npm run build`, apoi îl repornesc. Nu apăs „Reîncearcă” la facturi înainte de repornire.
- [ ] Schimb parola contului SUPER_ADMIN.
- [ ] Șterg linia `FGO_API` din `.env` și regenerez cheia FGO, pentru că a fost expusă.
- [ ] Verific facturile CNV-2026-000029 și CNV-2026-000030, care sunt în starea FAILED.
- [ ] Rezolv eroarea Bunny 401.
- [ ] Fac un repo git privat și urc codul. `.env` nu intră în repo.

## 2. Cumpăr VPS-ul

- [ ] Trimit tichet la Datahost (https://client.datahost.ro/), la departamentul de vânzări sau comercial.
- [ ] Cer minimum 2 vCPU, 4 GB RAM, 40 GB SSD, IPv4 dedicat, acces root și Ubuntu 24.04 LTS.
- [ ] Întreb dacă pot instala Node.js 22 și PostgreSQL, dacă portul 443 și conexiunile ieșite sunt deschise și dacă sunt incluse backupuri.
- [ ] Întreb dacă perioada rămasă din Găzduire Starter devine credit.
- [ ] Nu renunț la Găzduire Starter până nu verific ce folosesc pe el, mai ales emailul `@ivconcept.ro` și setările DNS.

## 3. Securizez serverul

```bash
ssh root@IP_VPS
apt update && apt upgrade -y
adduser app && usermod -aG sudo app
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

- [ ] Intru cu chei SSH și dezactivez autentificarea cu parolă.

## 4. Instalez programele

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs postgresql nginx certbot python3-certbot-nginx
node -v   # trebuie să fie minimum 22.18
```

## 5. Creez baza de date

Folosesc o bază nouă, fără datele de test din `cinevault_test`.

```bash
sudo -u postgres psql -c "CREATE USER ivconcept WITH PASSWORD 'PAROLA_LUNGA';"
sudo -u postgres psql -c "CREATE DATABASE ivconcept OWNER ivconcept;"
```

## 6. Urc aplicația

Clonez repo-ul în `/home/app/ivconcept` și creez `.env` pe server cu:

- `DATABASE_URL`
- `NODE_ENV=production`
- `PORT=3000`
- `TRUST_PROXY_HOPS=1`
- `UPLOAD_DIR=./storage`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`, cu o parolă nouă și puternică

```bash
npm ci --include=dev
npx prisma generate
npm run db:migrate
npm run build
```

Fără `--include=dev`, `NODE_ENV=production` poate sări peste pachetele necesare pentru build.

## 7. Pornesc aplicația ca serviciu

Creez `/etc/systemd/system/ivconcept.service`:

```ini
[Unit]
Description=IV Concept
After=network.target postgresql.service

[Service]
User=app
WorkingDirectory=/home/app/ivconcept
ExecStart=/usr/bin/node server.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ivconcept
journalctl -u ivconcept -f   # logurile
```

## 8. Leg domeniul și HTTPS

- [ ] Adaug un record DNS `A` pentru `shop` care indică IP-ul VPS-ului, acolo unde e administrat DNS-ul pentru `ivconcept.ro`. Nu ating recordurile pentru site-ul de pe Vercel sau pentru email.

Creez `/etc/nginx/sites-available/ivconcept`:

```nginx
server {
    server_name shop.ivconcept.ro;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ivconcept /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d shop.ivconcept.ro
```

## 9. Configurez din Admin → Setări

Baza fiind nouă, reintroduc setările.

- [ ] Site: URL `https://shop.ivconcept.ro` și datele reale ale firmei.
- [ ] Stripe: chei de test și webhook pe `https://shop.ivconcept.ro/api/payments/webhook`, cu evenimentele `checkout.session.completed`, `invoice.paid`, `charge.refunded`, `charge.dispute.created`.
- [ ] Bunny: adaug `shop.ivconcept.ro` la Allowed Domains și activez Block Direct URL File Access.
- [ ] FGO: înregistrez `https://shop.ivconcept.ro` ca platformă și folosesc întâi `api-testuat`.
- [ ] SMTP: adresa expeditorului trebuie să fie pe un domeniu verificat.

## 10. Fac backup zilnic

- [ ] Salvez `pg_dump` și folderul `storage/` în afara VPS-ului. `storage/` conține thumbnailurile și `.settings.key`. Fără această cheie nu mai pot citi setările criptate, dacă nu am setat `SETTINGS_ENCRYPTION_KEY`.

## 11. Testez, apoi trec pe live

- [ ] Fac o cumpărare de test cap-coadă: plată, deblocare video, factură și email.
- [ ] Urmăresc un film mai lung de 10 minute.
- [ ] Dau un refund de test și verific stornarea facturii.
- [ ] Trec pe Stripe live, cu un webhook live separat.
- [ ] Trec pe FGO producție, care cere abonament Premium.
- [ ] Verific totul cu contabilul și avocatul înainte de vânzări reale.

## La fiecare actualizare

```bash
git pull && npm ci --include=dev && npx prisma generate && npm run db:migrate && npm run build && sudo systemctl restart ivconcept
```
