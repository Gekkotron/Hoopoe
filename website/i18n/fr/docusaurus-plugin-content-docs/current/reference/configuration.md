---
title: Configuration
sidebar_position: 2
---

# Configuration

Hoopoe lit sa configuration depuis les variables d'environnement au démarrage
et depuis les réglages par utilisateur stockés en base. Cette page énumère
les deux, ainsi que les ports réseau par défaut sur lesquels les trois
services écoutent.

## Variables d'environnement

Les valeurs par défaut ci-dessous sont celles utilisées quand la variable
n'est pas définie. Copiez `.env.example` en `.env` avant de lancer
`docker compose up` et renseignez les champs marqués **requis**.

### PostgreSQL (service `db`)

| Variable | Défaut | Effet |
| --- | --- | --- |
| `POSTGRES_USER` | `athena` (à remplacer) | **Requis.** Rôle de base utilisé par le backend. Consommé aussi par l'image Postgres au premier boot. |
| `POSTGRES_PASSWORD` | *(aucun)* | **Requis.** Mot de passe du rôle `POSTGRES_USER`. Ne laissez jamais la valeur placeholder en production. |
| `POSTGRES_DB` | `athena` | Nom de la base créée au premier démarrage. |

### Backend (service `backend`)

| Variable | Défaut | Valeurs | Effet |
| --- | --- | --- | --- |
| `SESSION_SECRET` | *(aucun)* | ≥ 32 caractères | **Requis.** Signe le cookie de session et dérive la clé de chiffrement des payloads MCP. À générer avec `openssl rand -hex 32`. C'est aussi la clé racine des secrets 2FA, de synchronisation bancaire et de sauvegarde. La production refuse l'ancienne valeur d'exemple de `.env.example` (toute valeur contenant `replace-me`). La modifier déconnecte tout le monde ; définissez `SESSION_SECRET_PREVIOUS` pour un démarrage afin de conserver les secrets chiffrés. |
| `SESSION_SECRET_PREVIOUS` | *(non défini)* | chaîne | Uniquement pendant un changement de `SESSION_SECRET` : l'ancienne valeur, pour un démarrage. L'entrée Docker rechiffre tous les secrets 2FA, synchronisation bancaire, sauvegarde et MCP sous la nouvelle clé en une transaction, puis indique que la variable peut être retirée. Laissée en place au démarrage suivant, le backend s'arrête sans rien modifier. |
| `DATABASE_URL` | *(aucun)* | URL Postgres | **Requise quand `DB_DRIVER=postgres`.** URL complète, ex. `postgres://athena:…@db:5432/athena`. |
| `COOKIE_SECURE` | `false` | `true` / `false` / `1` / `0` | Marque le cookie de session comme `Secure`. À laisser sur `false` en déploiement LAN HTTP simple — sinon le navigateur rejette le cookie et la connexion échoue silencieusement. À passer à `true` derrière un reverse proxy HTTPS. |
| `NODE_ENV` | `development` | `development` / `production` / `test` | Contrôle le format des logs Fastify (`pino-pretty` en dev, JSON sinon) et active le serveur de fichiers statiques intégré quand `SERVE_STATIC` n'est pas défini. Docker Compose fixe cette variable à `production`. |
| `TRUST_PROXY` | *(non défini — `false`)* | `true` / nombre de sauts / liste d'IP, CIDR ou presets séparés par des virgules (`loopback`, `linklocal`, `uniquelocal`) | Transmis à l'option `trustProxy` de Fastify. Non défini ou `false` : `X-Forwarded-For` est ignoré (bureau, `npm run dev` nu). Docker Compose le fixe à `loopback,uniquelocal` pour que le conteneur nginx soit de confiance et que les limites de débit par client (connexion, 2FA, inscription) s'appuient sur la vraie IP du navigateur ; nginx écrase `X-Forwarded-For` avec `$remote_addr`, un client ne peut donc pas y injecter d'entrées. Ne faites confiance qu'aux adresses qui sont réellement votre proxy. Si vous placez un autre reverse proxy HTTPS devant nginx, tous les clients partagent l'IP de ce proxy, sauf si vous configurez vous-même `real_ip` dans nginx. |
| `METRICS_TOKEN` | *(non défini)* | chaîne, ≥ 16 caractères | Jeton bearer pour `GET /metrics` : les scrapers envoient `Authorization: Bearer <jeton>`. Non défini, `/metrics` est désactivé (404) sauf si `METRICS_PUBLIC=true`. À générer avec `openssl rand -hex 32`. |
| `METRICS_PUBLIC` | `false` | `true` / `false` / `1` / `0` | Sert `/metrics` sans authentification quand `METRICS_TOKEN` n'est pas défini. L'endpoint expose des compteurs inter-utilisateurs et des horodatages de sauvegarde : à n'activer que sur un LAN de confiance. Ignoré (avec un avertissement au démarrage) si `METRICS_TOKEN` est défini. |
| `ALLOW_REGISTRATION` | `true` | `true` / `false` | Le premier compte (onboarding) peut toujours être créé. Dès qu'un utilisateur existe, `false` fait renvoyer 403 `{ "error": "registration_closed" }` à `POST /api/onboarding/create` et masque le lien « Créer un compte » sur la page de connexion. Compose le lit depuis `.env`. À passer à `false` quand tout le foyer a son compte. |
| `PORT` | `3000` | entier | Port sur lequel Fastify écoute dans le conteneur. Docker Compose mappe `BACKEND_PORT` sur l'hôte vers ce port. |
| `DB_DRIVER` | `postgres` | `postgres` / `pglite` | Sélectionne le backend SQL. `postgres` utilise `pg.Pool` (parcours Docker). `pglite` utilise Postgres embarqué en WASM (Tauri desktop, tests). |
| `PGLITE_PATH` | *(non défini — en mémoire)* | chemin fichier | Utilisé uniquement quand `DB_DRIVER=pglite`. Définie, PGlite persiste dans ce répertoire ; non définie, base éphémère en mémoire. |
| `AUTH_MODE` | `session` | `session` / `none` | `session` est le parcours LAN/Docker : cookies + mots de passe argon2id, inscription via l'onboarding. `none` désactive complètement l'authentification — chaque requête est authentifiée comme un unique utilisateur local codé en dur. Le point d'entrée serveur (LAN/Docker) refuse de démarrer avec `none` ; ce mode est réservé au sidecar desktop, qui écoute sur `127.0.0.1` et ne répond qu'aux requêtes dont le `Host` est `127.0.0.1`, `localhost` ou `[::1]`. |
| `SERVE_STATIC` | *(non défini — suit `NODE_ENV=production`)* | `true` / `false` / `1` / `0` | Si vrai, Fastify sert aussi le frontend compilé depuis `STATIC_ROOT`. Utilisé par le sidecar Tauri ; Docker Compose garde nginx en frontal. |
| `STATIC_ROOT` | `<cwd>/frontend/dist` | chemin fichier | Répertoire depuis lequel Fastify sert le SPA quand `SERVE_STATIC` est actif. |
| `DATA_DIR` | `/data` (Docker) / CWD (dev) | chemin fichier | Répertoire racine des données utilisateur : fichier PGlite, sauvegardes, imports. Le point d'entrée Tauri le remplace par le dossier de données utilisateur spécifique à l'OS. |
| `OCR_LANG_PATH` | *(non défini — fetch CDN)* | chemin fichier | Chemin local vers les fichiers de langue Tesseract. Non défini, le premier OCR télécharge depuis un CDN — ce qui échoue en déploiement LAN sans internet. Les builds Docker embarquent les fichiers et fixent la variable automatiquement. |
| `WATCH_IMPORTS_DIR` | *(non défini — fonction désactivée)* | chemin fichier | Importeur par dossier surveillé (opt-in). Le backend scrute le dossier toutes les 60 s et importe les relevés (`.ofx`/`.qfx`/`.csv`/`.pdf`) déposés dans un sous-dossier portant le nom du compte de destination (insensible à la casse et aux accents). Le résultat est consigné en renommant le fichier : `.imported`, `.failed` (+ un `.error.txt` à côté), ou `.needs-template` pour les PDF sans modèle entraîné. Voir [Importer](../users/importing.md). |
| `BANK_SYNC_AUTO` | `1` | `1`/`0`, `true`/`false` | Synchronisation bancaire nocturne sans intervention pour les utilisateurs ayant configuré leurs identifiants Enable Banking dans *Données → Synchronisation bancaire*. Mettre à `0` pour désactiver le planificateur et ne synchroniser qu'à la demande depuis l'interface. Voir [Synchronisation bancaire](../users/bank-sync.md). |
| `BACKUP_AUTO` | `1` | `1`/`0`, `true`/`false` | Sauvegarde distante nocturne pour les utilisateurs ayant configuré une destination dans *Données → Sauvegarde*. Mettre à `0` pour désactiver le planificateur ; le bouton « Sauvegarder maintenant » reste fonctionnel. Voir [Sauvegarde et restauration](../users/backup-recovery.md#sauvegardes-distantes-planifiées). |

### Frontend (build-time, Vite)

Le frontend est un bundle statique — ces variables sont lues au moment du
`npm run build` par Vite et inlinées dans le `dist/` produit, pas lues à
l'exécution.

| Variable | Défaut | Effet |
| --- | --- | --- |
| `VITE_DEMO` | *(non défini)* | Quand elle vaut `1`, `npm run build` produit `frontend/dist-demo/` au lieu de `frontend/dist/`. Le bundle route chaque appel API vers un adaptateur navigateur alimenté par un jeu de données seed — aucun backend requis. Utilisé pour publier la démo publique GitHub Pages. |

### Ports hôte (overrides Compose)

| Variable | Défaut | Effet |
| --- | --- | --- |
| `FRONTEND_PORT` | `8000` | Port hôte mappé sur le port 8080 du conteneur frontend. Bindé sur `0.0.0.0` pour que les autres appareils du LAN atteignent l'application. |
| `BACKEND_PORT` | `8001` | Port hôte mappé sur le port 3000 du conteneur backend. Publié uniquement sur `127.0.0.1` : `curl http://127.0.0.1:8001/health` fonctionne depuis l'hôte, mais les autres appareils du LAN ne l'atteignent pas ; ils passent par le frontend, dont nginx proxifie tous les appels `/api/*` (y compris `/api/mcp/rpc`) vers le backend. |

Évitez `6000`, `6666`, `6665–6669` et `6697` — Chrome les bloque avec
`ERR_UNSAFE_PORT`.

## Ports réseau par défaut

| Service | Port hôte | Port conteneur | Bind |
| --- | --- | --- | --- |
| Frontend (nginx) | `${FRONTEND_PORT:-8000}` | `8080` | `0.0.0.0` (accessible LAN) |
| Backend (Fastify) | `${BACKEND_PORT:-8001}` | `3000` | `127.0.0.1` uniquement (jamais sur le LAN) |
| PostgreSQL | `5432` | `5432` | `127.0.0.1` uniquement (jamais sur le LAN) |

Commentez le bloc `ports:` du service `db` dans `docker-compose.yml` si vous
n'avez pas besoin de joindre Postgres depuis l'hôte — le backend le
contacte par le réseau Compose de toute façon.

## Réglages par utilisateur (page Réglages)

Ces valeurs sont persistées dans la colonne JSON `users.settings` et se
modifient depuis la page Réglages. Elles sont par utilisateur, pas par
installation. Le backend écrit les valeurs par défaut à la première
sauvegarde ; le frontend affiche les mêmes valeurs par défaut le temps que
le premier fetch aboutisse (source : `frontend/src/lib/settings.ts`).

| Réglage | Défaut | Valeurs | Effet |
| --- | --- | --- | --- |
| Période par défaut (`dashboardRange`) | `3m` | `30d`, `3m`, `6m`, `12m`, `all` | Fenêtre temporelle sur laquelle le tableau de bord s'ouvre à chaque chargement. Le sélecteur de période reste modifiable au sein d'une session. |
| Compte du graphique par défaut (`dashboardChartScope`) | `all` | `all` ou un id de compte | Compte(s) sur lesquels portent les graphiques du tableau de bord au chargement. `all` agrège tous les comptes. |
| Seuil de ligne pointillée (`chartGapThresholdDays`) | `6` | entier positif (jours) | Sur la courbe du solde, un écart entre deux points supérieur à ce seuil est tracé en pointillés — indice visuel qu'il manque peut-être des données (période sans import par exemple). |
| Seuil de similarité par défaut (`duplicateSimilarityThreshold`) | `0` | entier 0–100 | Filtre par défaut sur la liste « Possibles doublons » de Données → Doublons. Les groupes dont la similarité de libellés est inférieure au seuil sont masqués. `0` affiche tous les groupes candidats. |

*Voir aussi :* [Démarrage](/docs/users/getting-started) ·
[Sécurité et confidentialité](/docs/users/security-and-privacy)

← [Retour à l'index de la référence](README.md)
