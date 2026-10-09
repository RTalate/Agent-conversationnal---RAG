# AI SQL Query Generator

Application de démonstration du « Query RAG » : vous importez un fichier CSV, l'application le charge dans PostgreSQL et
l'analyse, puis vous l'interrogez en langage naturel. Un modèle d'IA, appelé via [OpenRouter](https://openrouter.ai) (le
modèle se change en une ligne), écrit la requête SQL, l'exécute et vous répond.

Tout tourne sur votre machine : l'application lance **sa propre base PostgreSQL**, sans Docker ni installation à part.

Vidéo d'explication :

[![Learn about Query RAG](https://img.youtube.com/vi/5LIfSpr3GDM/0.jpg)](https://youtu.be/5LIfSpr3GDM)
> 🎥 How to build advanced RAG systems with AI-generated SQL

**Sommaire** : [Démarrage rapide](#démarrage-rapide) · [Variantes](#variantes) · [Utiliser l'interface](#utiliser-linterface) ·
[Dépannage](#dépannage) · [Commandes](#commandes-make) · [Configuration](#configuration) ·
[Fonctionnement](#fonctionnement) · [Sécurité](#sécurité) · [Tests](#tests)

---

## Démarrage rapide

Objectif : de zéro à l'interface qui répond à vos questions, en 5 étapes. Toutes les commandes se tapent dans un
terminal Linux, macOS ou WSL (voir [Windows](#windows)).

### 0. Ce qu'il faut avoir

| Outil | Vérification | Installation |
|---|---|---|
| Git | `git --version` | [git-scm.com](https://git-scm.com) |
| Node.js 22 (LTS) | `node -v` affiche `v22.x` | [nodejs.org](https://nodejs.org) |
| GNU Make | `make --version` | macOS : `xcode-select --install` · Linux : `sudo apt install make` |
| Une clé API OpenRouter **avec du crédit** | — | [openrouter.ai/keys](https://openrouter.ai/keys) |

Utilisez votre compte utilisateur habituel, **pas root** : PostgreSQL refuse de tourner en root.
Pas de `make` ? Voir [Sans make](#sans-make).

Chaque import de CSV et chaque question appellent le modèle d'IA, via OpenRouter, qui est payant selon le modèle choisi.

### 1. Récupérer le code

```bash
git clone https://github.com/RTalate/Agent-conversationnal---RAG.git
cd Agent-conversationnal---RAG
```

Le dépôt est public : aucun identifiant n'est demandé.

### 2. Renseigner votre clé OpenRouter

```bash
cp server/.env.sample server/.env
```

Ouvrez `server/.env` et renseignez `OPENROUTER_API_KEY` avec votre clé. **Ne changez rien d'autre** pour commencer.

```env
OPENROUTER_API_KEY=sk-or-v1-...votre-clé...
```

Tant que la clé est vide, l'application refuse de démarrer et vous l'indique.

### 3. Lancer l'application

```bash
make dev
```

Au premier lancement, les dépendances sont installées (une à deux minutes) : cela inclut le moteur PostgreSQL, un
téléchargement de 60 à 150 Mo selon votre système. Vous devez ensuite voir `PostgreSQL started on port 54329`, puis
`Server running on port 3000` (l'API) et l'adresse `http://localhost:5173/` (l'interface). Laissez ce terminal ouvert.

### 4. Essayer l'interface

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

La réponse s'affiche en quelques secondes (plusieurs appels au modèle sont enchaînés).

### 5. Arrêter

**Ctrl-C** dans le terminal de `make dev` arrête l'API, l'interface et la base. Vos tables sont conservées dans
`server/.data/postgres` : la prochaine fois, relancez simplement `make dev`. Fermer le terminal arrête aussi tout
proprement. Pour tout effacer : `make db-reset`.

### Vérifier l'installation (facultatif)

Aucune base n'est à démarrer : chaque test lance la sienne. Cette commande vérifie les types, le lint, la compilation puis
lance tous les tests :

```bash
make verify
```

---

## Variantes

### Windows

`make` et le script de lancement demandent un shell Unix : utilisez **WSL2** (Ubuntu) et exécutez toutes les commandes
ci-dessus dans le terminal Ubuntu. Sans WSL, passez par [Sans make](#sans-make).

### Sans make

Deux terminaux, depuis la racine du dépôt :

```bash
cd server && npm ci && npm run dev   # 1. l'API, qui lance sa base
cd ui && npm ci && npm run dev       # 2. l'interface
```

### Changer de modèle d'IA

Ajoutez dans `server/.env` l'identifiant d'un modèle servi par OpenRouter ([liste](https://openrouter.ai/models)), puis
relancez `make dev` :

```env
LLM_MODEL=anthropic/claude-sonnet-4.5
```

Le modèle par défaut est `openai/gpt-4o-mini`. Si un modèle refuse le mode « JSON » de l'API, ajoutez `LLM_JSON_MODE=false` :
l'application sait aussi lire une réponse entourée de balises de code Markdown.

Pour une passerelle interne ou un autre fournisseur compatible avec l'API OpenAI, renseignez en plus `LLM_BASE_URL`.

### Votre propre PostgreSQL

Pour utiliser un PostgreSQL existant au lieu de celui de l'application, dans `server/.env` :

```env
DB_EMBEDDED=false
DB_HOST=...      # puis DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
```

La base `DB_NAME` doit exister. C'est aussi la solution si vous devez lancer l'application en root (conteneur, serveur
partagé) sans utilisateur système `postgres`.

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
- Si le modèle écrit une requête invalide, l'application la lui fait corriger : trois essais au maximum, puis elle
  l'indique.

---

## Dépannage

Regardez toujours **le terminal où tourne `make dev`** : il contient la cause réelle, que l'interface résume en une ligne.

| Ce que vous voyez | Cause probable | Que faire |
|---|---|---|
| `make: command not found` | `make` n'est pas installé | Voir l'[étape 0](#0-ce-quil-faut-avoir) ou [Sans make](#sans-make) |
| `make dev` : `server/.env is missing` | Le fichier de configuration n'existe pas | `cp server/.env.sample server/.env` (étape 2) |
| `Failed to start server: OPENROUTER_API_KEY is not set` | La clé est vide ou absente de `server/.env` | Renseignez-la (étape 2) et relancez. `OPENAI_API_KEY` n'est plus lue |
| `Failed to start server: Port … is already used by another program` | Un autre programme occupe le port : celui de l'API (3000) ou celui de la base (54329) | Fermez-le, ou changez `PORT` (API, et lancez alors avec `VITE_API_URL=http://localhost:<port> make dev`) ou `DB_PORT` (base) dans `server/.env` |
| `A PostgreSQL server is already listening on port … but rejected the user` | Un autre PostgreSQL occupe ce port avec d'autres identifiants | Changez `DB_PORT`, ou alignez `DB_USER` et `DB_PASSWORD` |
| `Could not start the embedded PostgreSQL … PostgreSQL cannot run as root` | Vous êtes root | Lancez avec un utilisateur normal, ou utilisez [votre propre PostgreSQL](#votre-propre-postgresql) |
| `Could not start the embedded PostgreSQL …` (autre cause) | Le dossier de données n'est pas utilisable | Lisez la fin du message. Si les données sont inutiles : `make db-reset`. Sinon `DB_DATA_DIR` vers un dossier où vous pouvez écrire |
| L'interface affiche `Failed to fetch` | L'API n'est pas démarrée ou n'est pas à l'adresse attendue | Vérifiez le terminal de `make dev` ; l'API répond sur `http://localhost:3000` (une page « 404 » à cette adresse est normale : elle n'a pas de page d'accueil) |
| `Failed to process CSV file` ou `Failed to process query` | Échec de l'appel au modèle, ou d'une étape interne | Lisez le terminal. `401` : clé refusée. `402` : plus de crédit OpenRouter. `429` : trop de requêtes. Un identifiant de modèle inconnu : vérifiez `LLM_MODEL` |
| `Invalid table name: …` | Le nom contient un caractère interdit | Voir les [règles de nom](#utiliser-linterface) |
| `A table named "…" already exists and was not created by this application` | Une table de ce nom existe déjà dans la base | Choisissez un autre nom |
| `Invalid CSV file: …` ou `CSV file is empty` | Le fichier est mal formé (nombre de colonnes différent selon les lignes) ou sans données | Corrigez le fichier |
| `Please choose a .csv file.` | Le fichier n'a pas l'extension `.csv` | Choisissez un fichier `.csv` |
| Les questions n'obtiennent pas de bonne réponse | Le modèle a mal compris la table | Reformulez en citant les noms de colonnes ; essayez un autre `LLM_MODEL` |
| La base reste active après un arrêt brutal (`kill -9`, plantage) | Le processus qui la gérait a disparu | Rien à faire : le prochain `make dev` la reprend et l'arrêtera. Sinon `make db-stop` |

---

## Commandes make

`make` seul affiche la liste.

| Commande | Rôle |
|---|---|
| `make dev` | Lance l'API (3000) et l'interface (5173). Ctrl-C arrête les deux ; si l'un des deux s'arrête, l'autre aussi. |
| `make test` | Lance tous les tests (voir [Tests](#tests)), sans rien à démarrer avant. |
| `make check` | Vérifie les types, lance le lint et compile le serveur et l'interface. |
| `make verify` | `make check` puis `make test`. |
| `make install` | Installe les dépendances du serveur et de l'interface (fait automatiquement au besoin). |
| `make db-stop` | Arrête la base locale si un lancement précédent l'a laissée active. |
| `make db-reset` | Arrête la base locale et **supprime ses données** (toutes les tables importées). |
| `make clean` | Supprime les fichiers compilés. |

## Configuration

Tout se règle dans `server/.env` (copié depuis `server/.env.sample`).

| Variable | Valeur par défaut | Rôle |
|---|---|---|
| `OPENROUTER_API_KEY` | *(vide : à renseigner)* | Votre clé OpenRouter. Obligatoire. |
| `LLM_MODEL` | `openai/gpt-4o-mini` | Modèle utilisé pour tous les appels (facultatif). |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Autre API compatible OpenAI (facultatif). |
| `LLM_JSON_MODE` | `true` | `false` si un modèle refuse le mode JSON de l'API (facultatif). |
| `DB_USER` / `DB_PASSWORD` | `postgres` / `admin` | Identifiants PostgreSQL. |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `54329` | Adresse de PostgreSQL. |
| `DB_NAME` | `sqlgen` | Base utilisée par l'application. |
| `DB_EMBEDDED` | `true` | `false` : l'application se connecte à votre PostgreSQL au lieu de lancer le sien. |
| `DB_DATA_DIR` | `server/.data/postgres` | Où la base embarquée garde ses données. |
| `PORT` | `3000` | Port de l'API. |
| `DB_READONLY_USER` / `DB_READONLY_PASSWORD` | — | Rôle SQL en lecture seule pour les requêtes écrites par le modèle (facultatif, voir [Sécurité](#sécurité)). |

L'interface appelle l'API sur `http://localhost:3000`. Pour une autre adresse, définissez `VITE_API_URL` au lancement :
`VITE_API_URL=http://localhost:4000 make dev`.

---

## Fonctionnement

![AI SQL Query Generator Architecture](./architecture.png)

- **Interface** (`ui/`) : React, TypeScript et composants shadcn/ui. Elle envoie les CSV et les questions à l'API.
- **API** (`server/src`) : Express, TypeScript et PostgreSQL. Elle appelle le modèle d'IA par une API compatible OpenAI
  (OpenRouter par défaut).
- **Racine** : `Makefile` (commandes), `scripts/dev.sh` (lancement conjoint), `data/` (CSV d'exemple).

**La base de données.** Au démarrage, l'API lance un vrai serveur PostgreSQL, fourni par un paquet npm
([embedded-postgres](https://github.com/leinelissen/embedded-postgres)) : il écoute **uniquement sur la machine locale**
et garde ses données dans `server/.data/postgres`. L'API l'arrête quand elle s'arrête (Ctrl-C, `kill`, fermeture du
terminal). Si une base reste active après un arrêt brutal, elle est reprise et arrêtée au lancement suivant ; un
PostgreSQL qui n'est pas le sien n'est jamais arrêté. Lancez un seul serveur par dossier de données.

**Import d'un CSV**
1. L'API détecte les types des colonnes et crée la table PostgreSQL (en une seule transaction : un import qui échoue ne
   détruit pas la table existante).
2. L'analyseur de tables (`server/src/tableAnalyzer.ts`) échantillonne les données, calcule des statistiques (types,
   valeurs distinctes, part de valeurs nulles, minimum et maximum) et demande au modèle de décrire chaque colonne. Ces
   descriptions sont conservées pour répondre aux questions.

**Question**
1. **Triage** : la question est classée « sur les données », « générale » ou « hors sujet ».
2. **Analyse du schéma** : le modèle identifie les tables et colonnes utiles.
3. **Génération SQL** : le modèle écrit une requête PostgreSQL.
4. **Exécution** : la requête s'exécute en lecture seule.
5. **Réponse** : le résultat est reformulé en langage naturel, puis **validé** ; en cas d'échec, la requête est régénérée en
   tenant compte de l'erreur précédente (trois essais au maximum).

## Sécurité

Il s'agit d'une preuve de concept, mais deux protections sont en place car elles sont peu coûteuses et qu'un échec
signifierait une perte de données :

- **Noms de table** : validés (`^[a-z_][a-z0-9_]{0,62}$` après mise en minuscules) et toujours quotés. La table interne
  `table_schema` et les noms `pg_*` sont réservés.
- **SQL écrit par le modèle** : n'est exécuté que s'il s'agit d'une seule instruction `SELECT`/`WITH`, dans une transaction
  `READ ONLY` toujours annulée, avec un délai maximal de 10 secondes.

`READ ONLY` empêche les écritures, pas les lectures. `DB_USER` est un superutilisateur (c'est le cas de la base embarquée) :
le SQL du modèle peut donc encore appeler des fonctions comme `pg_read_file`, qui lisent des fichiers de votre machine. Pour
fermer ce cas, créez un rôle qui ne peut que lire et renseignez `DB_READONLY_USER` / `DB_READONLY_PASSWORD`. Exécutez ceci
avec `DB_USER`, dans la base de l'application (par exemple avec `psql -h 127.0.0.1 -p 54329 -U postgres sqlgen`) :

```sql
CREATE ROLE sqlgen_readonly LOGIN PASSWORD 'change_me';
GRANT CONNECT ON DATABASE sqlgen TO sqlgen_readonly;
GRANT USAGE ON SCHEMA public TO sqlgen_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sqlgen_readonly;
-- tables créées par les imports suivants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sqlgen_readonly;
```

**Non couvert** : authentification, CORS, limitation du débit et nettoyage des fichiers importés (dossier
`server/uploads`). Les données des CSV (échantillons, résultats de requêtes) sont envoyées au modèle choisi, par
OpenRouter, sans filtrage. L'API écoute sur toutes les interfaces réseau, sans authentification et avec CORS ouvert : ne la
lancez que sur un réseau de confiance. La base, elle, n'est joignable que depuis la machine locale, avec des identifiants par
défaut (`postgres` / `admin`) à changer si la machine est partagée.

## Tests

`make test` lance tout, sans rien à installer ni à démarrer avant. Détail :

**Serveur** (`cd server`, Node 22 ou plus) :

| Commande | Ce qu'elle lance | Prérequis |
|---|---|---|
| `npm run test:unit` | Fonctions pures : configuration, gardes sur les noms de table et le SQL, détection des types CSV, lecture des réponses du modèle | rien |
| `npm run test:integration` | Les vraies routes, le SQL et le pipeline : imports et injection SQL, garde en lecture seule, rôle dédié, appels au fournisseur d'IA, cycle de vie de la base, processus serveur et signaux | rien |
| `npm test` | Les deux | rien |
| `npm run typecheck` | Vérifie les types de `src` et `test` | rien |

Les tests d'intégration n'appellent jamais OpenRouter : l'application parle à un faux local
(`server/test/helpers/fake-openai.ts`), donc pas de clé ni de coût. Chaque fichier de test lance **son propre PostgreSQL**
(le même que celui de l'application), sur un port libre et dans un dossier temporaire, puis le supprime : votre base et votre
`server/.env` ne sont jamais utilisés. `TEST_VERBOSE=1` affiche les journaux de l'application. Si une exécution est
interrompue de force, des dossiers `sqlgen-*` peuvent rester dans le dossier temporaire du système : supprimez-les à la main.

**Interface** (`cd ui`) : `npm test` lance les tests de composants (Vitest et Testing Library, avec l'API remplacée par un
faux `fetch`) ; `npm run test:watch` les relance à chaque modification.

## Contribuer

Il s'agit d'une preuve de concept, non destinée à la production. Ce dépôt est à visée pédagogique et ne sera pas
maintenu : n'hésitez pas à le dupliquer (fork) et à le faire évoluer.

## Licence

Licence MIT : réutilisez ce code librement pour vos propres projets.
