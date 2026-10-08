# AI SQL Query Generator

Application de démonstration du « Query RAG » : vous importez un fichier CSV, l'application le charge dans PostgreSQL et
l'analyse, puis vous l'interrogez en langage naturel. Une IA (OpenAI) écrit la requête SQL, l'exécute et vous répond.

Vidéo d'explication :

[![Learn about Query RAG](https://img.youtube.com/vi/5LIfSpr3GDM/0.jpg)](https://youtu.be/5LIfSpr3GDM)
> 🎥 How to build advanced RAG systems with AI-generated SQL

**Sommaire** : [Démarrage rapide](#démarrage-rapide) · [Variantes](#variantes) · [Utiliser l'interface](#utiliser-linterface) ·
[Dépannage](#dépannage) · [Commandes](#commandes-make) · [Configuration](#configuration) ·
[Fonctionnement](#fonctionnement) · [Sécurité](#sécurité) · [Tests](#tests)

---

## Démarrage rapide

Objectif : de zéro à l'interface qui répond à vos questions, en 6 étapes. Toutes les commandes se tapent dans un
terminal Linux, macOS ou WSL (voir [Windows](#windows)).

### 0. Ce qu'il faut avoir

| Outil | Vérification | Installation |
|---|---|---|
| Git | `git --version` | [git-scm.com](https://git-scm.com) |
| Node.js 22 (LTS) | `node -v` affiche `v22.x` | [nodejs.org](https://nodejs.org) |
| Docker avec Compose v2 | `docker compose version` | [docker.com](https://www.docker.com/products/docker-desktop/) (Docker Desktop doit être **lancé**) |
| GNU Make | `make --version` | macOS : `xcode-select --install` · Linux : `sudo apt install make` |
| Une clé API OpenAI **avec du crédit** | — | [platform.openai.com](https://platform.openai.com) → *API keys* |

Pas de Docker sur cette machine ? Voir [PostgreSQL déjà installé](#postgresql-déjà-installé-sans-docker).
Pas de `make` ? Voir [Sans make](#sans-make).

Chaque import de CSV et chaque question appellent l'API OpenAI, qui est payante (modèle `gpt-4o-mini` par défaut).

### 1. Récupérer le code

```bash
git clone https://github.com/RTalate/Agent-conversationnal---RAG.git
cd Agent-conversationnal---RAG
```

Le dépôt est public : aucun identifiant n'est demandé.

### 2. Renseigner votre clé OpenAI

```bash
cp server/.env.sample server/.env
```

Ouvrez `server/.env` et remplacez la valeur de `OPENAI_API_KEY` par votre clé. **Ne changez rien d'autre** : les autres
valeurs correspondent déjà à la base de l'étape suivante.

```env
OPENAI_API_KEY=sk-...votre-clé...
```

### 3. Démarrer la base de données

```bash
make db-up
```

La commande rend la main quand PostgreSQL est prêt (au premier lancement, Docker télécharge d'abord l'image).

### 4. Lancer l'application

```bash
make dev
```

Au premier lancement, les dépendances sont installées (environ une minute). Vous devez ensuite voir
`Server running on port 3000` (l'API) et l'adresse `http://localhost:5173/` (l'interface). Laissez ce terminal ouvert.

### 5. Essayer l'interface

Ouvrez **http://localhost:5173** dans votre navigateur.

1. Dans **Table Name**, saisissez `customers`.
2. Glissez-déposez le fichier `data/customers-1000.csv` (fourni dans le dépôt) dans la zone en pointillés, ou cliquez
   dessus pour le choisir.
3. Cliquez sur **Upload CSV**. Au bout de quelques secondes, un message vert doit apparaître :
   `Imported 12 columns into table "customers".`
4. Dans **Ask about your data**, posez une question puis cliquez sur **Ask**, par exemple :
   - `How many customers are there in each country?`
   - `Which companies have more than one customer?`
   - `How many customers subscribed in 2021?`

La réponse s'affiche en quelques secondes (plusieurs appels à OpenAI sont enchaînés).

### 6. Arrêter

- Dans le terminal de `make dev` : **Ctrl-C** (arrête l'API et l'interface).
- Puis `make db-down` pour arrêter la base. Vos tables sont conservées : la prochaine fois, relancez simplement
  `make db-up` puis `make dev`. Pour tout effacer, utilisez `make db-reset`.

### Vérifier l'installation (facultatif)

Avec la base démarrée (`make db-up`), cette commande vérifie les types, le lint, la compilation puis lance tous les tests :

```bash
make verify
```

---

## Variantes

### Windows

`make` et le script de lancement demandent un shell Unix : utilisez **WSL2** (Ubuntu) et installez Docker Desktop avec
l'option « WSL integration ». Exécutez ensuite toutes les commandes ci-dessus dans le terminal Ubuntu.
Sans WSL, passez par [Sans make](#sans-make).

### Sans make

Trois terminaux, depuis la racine du dépôt :

```bash
docker compose up -d --wait db      # 1. la base (si `--wait` n'est pas reconnu : `docker compose up -d db`, puis attendez ~10 s)
cd server && npm ci && npm run dev  # 2. l'API
cd ui && npm ci && npm run dev      # 3. l'interface
```

### PostgreSQL déjà installé (sans Docker)

Sautez l'étape 3 (`make db-up`). Créez une base et indiquez ses paramètres dans `server/.env` :

```bash
psql -U postgres -c "CREATE DATABASE sqlgen;"
```

Adaptez ensuite `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT` et `DB_NAME` dans `server/.env` à votre installation, puis
passez à l'étape 4.

---

## Utiliser l'interface

**Importer un CSV**
- La première ligne doit contenir les noms de colonnes ; le séparateur est la virgule.
- Les types sont détectés sur toutes les lignes : entier, décimal, date ISO (`2021-07-26`, avec ou sans heure) ou texte.
  Les dates au format `26/07/2021` restent du texte. Les cases vides deviennent `NULL`.
- **Nom de table** : lettres, chiffres et `_`, commençant par une lettre ou `_`, 63 caractères au maximum. Il est enregistré
  en minuscules. `table_schema` et les noms commençant par `pg_` sont réservés.
- Réimporter sous le même nom **remplace** la table. Une table qui existe déjà sans avoir été créée par l'application
  n'est jamais écrasée : l'interface affiche une erreur et vous choisissez un autre nom.

**Poser des questions**
- Interrogez les tables que vous avez importées, en langage naturel.
- Vous pouvez aussi poser une question générale sur les données ou sur SQL ; une question sans rapport avec ce sujet reçoit
  une réponse de refus poli.
- Si l'IA écrit une requête invalide, l'application la lui fait corriger : trois essais au maximum, puis elle l'indique.

---

## Dépannage

Regardez toujours **le terminal où tourne `make dev`** : il contient la cause réelle, que l'interface résume en une ligne.

| Ce que vous voyez | Cause probable | Que faire |
|---|---|---|
| `make: command not found` | `make` n'est pas installé | Voir l'[étape 0](#0-ce-quil-faut-avoir) ou [Sans make](#sans-make) |
| `make dev` : `server/.env is missing` | Le fichier de configuration n'existe pas | `cp server/.env.sample server/.env` (étape 2) |
| `make db-up` : `port is already allocated` | Un PostgreSQL local occupe déjà le port 5432 | Arrêtez-le, ou remplacez `127.0.0.1:5432:5432` par `127.0.0.1:5433:5432` dans `docker-compose.yml` et mettez `DB_PORT=5433` dans `server/.env` |
| `make db-up` : `--wait` non reconnu | Docker Compose ancien | `docker compose up -d db`, puis attendez une dizaine de secondes |
| `Failed to start server: … ECONNREFUSED` | La base n'est pas démarrée ou `DB_*` est faux | `make db-up` (et vérifiez que Docker est lancé), puis relancez `make dev` |
| `listen EADDRINUSE … :3000` | Le port 3000 est pris par un autre programme | Fermez-le, ou changez `PORT` dans `server/.env` **et** lancez avec `VITE_API_URL=http://localhost:<port> make dev` |
| L'interface affiche `Failed to fetch` | L'API n'est pas démarrée ou n'est pas à l'adresse attendue | Vérifiez le terminal de `make dev` ; l'API répond sur `http://localhost:3000` (une page « 404 » à cette adresse est normale : elle n'a pas de page d'accueil) |
| `Failed to process CSV file` ou `Failed to process query` | Échec de l'appel à OpenAI ou d'une étape interne | Lisez le terminal. `401 Incorrect API key` : clé absente, fausse ou encore à la valeur d'exemple de `.env.sample` (étape 2, puis relancez `make dev`). Une erreur `429` : crédit ou quota OpenAI épuisé |
| `Invalid table name: …` | Le nom contient un caractère interdit | Voir les [règles de nom](#utiliser-linterface) |
| `A table named "…" already exists and was not created by this application` | Une table de ce nom existe déjà dans la base | Choisissez un autre nom |
| `Invalid CSV file: …` ou `CSV file is empty` | Le fichier est mal formé (nombre de colonnes différent selon les lignes) ou sans données | Corrigez le fichier |
| `Please choose a .csv file.` | Le fichier n'a pas l'extension `.csv` | Choisissez un fichier `.csv` |
| Les questions n'obtiennent pas de bonne réponse | L'IA a mal compris la table | Reformulez en citant les noms de colonnes ; relancez l'import si vous avez changé le fichier |

---

## Commandes make

`make` seul affiche la liste.

| Commande | Rôle |
|---|---|
| `make dev` | Lance l'API (3000) et l'interface (5173). Ctrl-C arrête les deux ; si l'un des deux s'arrête, l'autre aussi. |
| `make db-up` | Démarre PostgreSQL dans Docker, avec les identifiants de `server/.env.sample`. |
| `make db-down` | Arrête la base (les données sont conservées). |
| `make db-reset` | Arrête la base **et supprime ses données**. |
| `make install` | Installe les dépendances du serveur et de l'interface (fait automatiquement au besoin). |
| `make test` | Lance tous les tests (voir [Tests](#tests)). |
| `make check` | Vérifie les types, lance le lint et compile le serveur et l'interface. |
| `make verify` | `make check` puis `make test`. |
| `make clean` | Supprime les fichiers compilés. |

## Configuration

Tout se règle dans `server/.env` (copié depuis `server/.env.sample`).

| Variable | Valeur d'exemple | Rôle |
|---|---|---|
| `OPENAI_API_KEY` | *(à remplacer)* | Votre clé OpenAI. Obligatoire. |
| `DB_USER` / `DB_PASSWORD` | `postgres` / `admin` | Identifiants PostgreSQL. |
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` | Adresse de PostgreSQL. |
| `DB_NAME` | `sqlgen` | Base utilisée par l'application. |
| `PORT` | `3000` | Port de l'API. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Modèle OpenAI (facultatif). |
| `DB_READONLY_USER` / `DB_READONLY_PASSWORD` | — | Rôle SQL en lecture seule pour les requêtes écrites par l'IA (facultatif, voir [Sécurité](#sécurité)). |

L'interface appelle l'API sur `http://localhost:3000`. Pour une autre adresse, définissez `VITE_API_URL` au lancement :
`VITE_API_URL=http://localhost:4000 make dev`.

`docker-compose.yml` utilise les mêmes identifiants que `server/.env.sample` : si vous modifiez l'un, modifiez l'autre.

---

## Fonctionnement

![AI SQL Query Generator Architecture](./architecture.png)

- **Interface** (`ui/`) : React, TypeScript et composants shadcn/ui. Elle envoie les CSV et les questions à l'API.
- **API** (`server/src`) : Express, TypeScript et PostgreSQL.
- **Racine** : `Makefile` (commandes), `docker-compose.yml` (PostgreSQL), `scripts/dev.sh` (lancement conjoint),
  `data/` (CSV d'exemple).

**Import d'un CSV**
1. L'API détecte les types des colonnes et crée la table PostgreSQL (en une seule transaction : un import qui échoue ne
   détruit pas la table existante).
2. L'analyseur de tables (`server/src/tableAnalyzer.ts`) échantillonne les données, calcule des statistiques (types,
   valeurs distinctes, part de valeurs nulles, minimum et maximum) et demande à l'IA de décrire chaque colonne. Ces
   descriptions sont conservées pour répondre aux questions.

**Question**
1. **Triage** : la question est classée « sur les données », « générale » ou « hors sujet ».
2. **Analyse du schéma** : l'IA identifie les tables et colonnes utiles.
3. **Génération SQL** : l'IA écrit une requête PostgreSQL.
4. **Exécution** : la requête s'exécute en lecture seule.
5. **Réponse** : le résultat est reformulé en langage naturel, puis **validé** ; en cas d'échec, la requête est régénérée en
   tenant compte de l'erreur précédente (trois essais au maximum).

## Sécurité

Il s'agit d'une preuve de concept, mais deux protections sont en place car elles sont peu coûteuses et qu'un échec
signifierait une perte de données :

- **Noms de table** : validés (`^[a-z_][a-z0-9_]{0,62}$` après mise en minuscules) et toujours quotés. La table interne
  `table_schema` et les noms `pg_*` sont réservés.
- **SQL écrit par l'IA** : n'est exécuté que s'il s'agit d'une seule instruction `SELECT`/`WITH`, dans une transaction
  `READ ONLY` toujours annulée, avec un délai maximal de 10 secondes.

`READ ONLY` empêche les écritures, pas les lectures. Si `DB_USER` est un superutilisateur (comme dans la configuration
d'exemple), le SQL de l'IA peut encore appeler des fonctions comme `pg_read_file`. Pour fermer ce cas, créez un rôle qui
ne peut que lire et renseignez `DB_READONLY_USER` / `DB_READONLY_PASSWORD`. Exécutez ceci avec `DB_USER`, dans la base de
l'application :

```sql
CREATE ROLE sqlgen_readonly LOGIN PASSWORD 'change_me';
GRANT CONNECT ON DATABASE sqlgen TO sqlgen_readonly;
GRANT USAGE ON SCHEMA public TO sqlgen_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sqlgen_readonly;
-- tables créées par les imports suivants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sqlgen_readonly;
```

**Non couvert** : authentification, CORS, limitation du débit et nettoyage des fichiers importés (dossier
`server/uploads`). Les résultats des requêtes sont envoyés à OpenAI sans filtrage. L'API écoute sur toutes les interfaces
réseau, sans authentification et avec CORS ouvert : ne la lancez que sur un réseau de confiance. PostgreSQL (Docker) n'est
exposé que sur la machine locale.

## Tests

`make test` lance tout. Détail :

**Serveur** (`cd server`, Node 22 ou plus) :

| Commande | Ce qu'elle lance | Prérequis |
|---|---|---|
| `npm run test:unit` | Fonctions pures : gardes sur les noms de table et le SQL, détection des types CSV, lecture des réponses de l'IA | rien |
| `npm run test:integration` | Les vraies routes, le SQL et le pipeline IA : imports et injection SQL, garde en lecture seule, rôle dédié, `/query` | PostgreSQL |
| `npm test` | Les deux | PostgreSQL |
| `npm run typecheck` | Vérifie les types de `src` et `test` | rien |

Les tests d'intégration n'appellent jamais OpenAI : l'application parle à un faux local
(`server/test/helpers/fake-openai.ts`), donc pas de clé ni de coût. Chaque fichier de test crée sa propre base jetable
(`sqlgen_test_*`) et la supprime ensuite ; `DB_NAME` n'est jamais utilisé. Ils se connectent avec `DB_HOST`, `DB_PORT`,
`DB_USER` et `DB_PASSWORD` (environnement ou `server/.env`) ; cet utilisateur doit pouvoir créer des bases et des rôles
(un superutilisateur comme `postgres` le peut). `TEST_VERBOSE=1` affiche les journaux de l'application. Si une exécution est
interrompue de force, les bases `sqlgen_test_*` et les rôles `sqlgen_ro_*` qu'elle a créés peuvent rester : supprimez-les à
la main.

**Interface** (`cd ui`) : `npm test` lance les tests de composants (Vitest et Testing Library, avec l'API remplacée par un
faux `fetch`) ; `npm run test:watch` les relance à chaque modification.

## Contribuer

Il s'agit d'une preuve de concept, non destinée à la production. Ce dépôt est à visée pédagogique et ne sera pas
maintenu : n'hésitez pas à le dupliquer (fork) et à le faire évoluer.

## Licence

Licence MIT : réutilisez ce code librement pour vos propres projets.
