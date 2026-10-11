# AI SQL Query Generator

Application de démonstration du « Query RAG » : vous importez un fichier CSV, l'application le charge dans PostgreSQL et
l'analyse, puis vous l'interrogez en langage naturel. Un modèle d'IA, appelé via [OpenRouter](https://openrouter.ai) (le
modèle se change en une ligne), écrit la requête SQL, l'exécute et vous répond.

Tout tourne sur votre machine, sous **Windows, macOS ou Linux** : l'application lance **sa propre base PostgreSQL**, sans
Docker, sans WSL et sans rien installer à part.

Vidéo d'explication :

[![Learn about Query RAG](https://img.youtube.com/vi/5LIfSpr3GDM/0.jpg)](https://youtu.be/5LIfSpr3GDM)
> 🎥 How to build advanced RAG systems with AI-generated SQL

**Sommaire** : [Démarrage rapide](#démarrage-rapide) · [Variantes](#variantes) · [Utiliser l'interface](#utiliser-linterface) ·
[Dépannage](#dépannage) · [Commandes](#commandes) · [Configuration](#configuration) ·
[Fonctionnement](#fonctionnement) · [Sécurité](#sécurité) · [Tests](#tests)

---

## Démarrage rapide

Objectif : de zéro à l'interface qui répond à vos questions, en 5 étapes. Les commandes sont **les mêmes partout** : dans
PowerShell sous Windows (l'application « Terminal »), dans un terminal sous macOS et Linux.

### 0. Ce qu'il faut avoir

| Outil | Vérification | Installation | Désinstallation |
|---|---|---|---|
| Git | `git --version` | [git-scm.com](https://git-scm.com/downloads) (Windows : options par défaut) | Windows : Paramètres › Applications › Applications installées › Git › Désinstaller · macOS : `brew uninstall git` s'il vient de Homebrew ; sinon il fait partie des outils de développement Apple, retirés avec `sudo rm -rf /Library/Developer/CommandLineTools` · Linux : `sudo apt remove git` |
| Node.js 22 ou plus récent | `node -v` affiche `v22` ou plus | [nodejs.org](https://nodejs.org/fr/download), version LTS (Windows : installateur `.msi` x64, options par défaut) | D'abord `npm cache clean --force` (vide le cache des téléchargements). Puis Windows : Paramètres › Applications › Applications installées › Node.js › Désinstaller · macOS : `sudo rm -rf /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/lib/node_modules /usr/local/include/node` · Linux : selon votre installation, `sudo apt remove nodejs` ou `nvm uninstall 22` |
| **Windows uniquement** : Microsoft Visual C++ Redistributable (x64), utilisé par PostgreSQL | Paramètres › Applications › Applications installées : « Microsoft Visual C++ … Redistributable (x64) » | [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe) (sans danger s'il est déjà installé) | Paramètres › Applications › Applications installées › Microsoft Visual C++ … Redistributable (x64) › Désinstaller. **Dans le doute, gardez-le** : beaucoup de logiciels s'en servent |
| Une clé API OpenRouter **avec du crédit** | — | [openrouter.ai/keys](https://openrouter.ai/keys) | Supprimez la clé sur la même page |
| Ce projet : le code, ses dépendances, le moteur PostgreSQL et vos données | — | Étapes 1 à 3 ci-dessous | Arrêtez l'application (Ctrl-C), puis supprimez le dossier du projet. Rien d'autre n'est installé sur la machine : ni service, ni programme global |

Pour tout retirer, suivez la dernière colonne de bas en haut : le projet, la clé, puis les outils, que d'autres projets
utilisent peut-être.

Chaque import de CSV et chaque question appellent le modèle d'IA, via OpenRouter, qui est payant selon le modèle choisi.

#### Sous Windows

- **Ouvrez « Terminal » normalement**, pas « en tant qu'administrateur ».
- **Placez le projet dans un dossier simple**, par exemple `C:\dev` : pas dans Documents ni sur le Bureau, que OneDrive
  synchronise souvent (il copierait la base pendant qu'elle tourne), et sans accent dans le chemin.
- **Si `npm` répond « l'exécution de scripts est désactivée sur ce système »**, autorisez-les une fois pour votre compte :
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (ou tapez `npm.cmd` au lieu de `npm`).
- **PC à processeur ARM** (Snapdragon, par exemple) : il n'existe pas de PostgreSQL embarqué pour eux ; utilisez
  [votre propre PostgreSQL](#votre-propre-postgresql). Pour le savoir : Paramètres › Système › Informations système ›
  « Type du système ».

Sous macOS et Linux, utilisez votre compte habituel, **pas root** : PostgreSQL refuse de tourner en root.

### 1. Récupérer le code

Sous Windows, placez-vous d'abord dans un dossier simple : `mkdir C:\dev; cd C:\dev`. Puis, partout :

```bash
git clone https://github.com/RTalate/Agent-conversationnal---RAG.git
cd Agent-conversationnal---RAG
```

Le dépôt est public : aucun identifiant n'est demandé.

### 2. Renseigner votre clé OpenRouter

```bash
cp server/.env.sample server/.env
```

Ouvrez `server/.env` dans un éditeur de texte (sous Windows : `notepad server\.env`) et renseignez `OPENROUTER_API_KEY`
avec votre clé. **Ne changez rien d'autre** pour commencer.

```env
OPENROUTER_API_KEY=sk-or-v1-...votre-clé...
```

Tant que la clé est vide, l'application refuse de démarrer et vous l'indique.

### 3. Lancer l'application

```bash
npm run dev
```

Au premier lancement, les dépendances sont installées (une à trois minutes) : cela inclut le moteur PostgreSQL, un
téléchargement de 60 à 150 Mo selon votre système. Vous devez ensuite voir `[api] PostgreSQL started on port 54329`,
`[api] Server running on port 3000`, puis `Ready: open http://localhost:5173 in your browser`. Laissez ce terminal ouvert.

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

**Ctrl-C** dans le terminal de `npm run dev` arrête l'interface, l'API et la base (sous Windows, si la question
« Terminer le programme de commandes (O/N) ? » apparaît, répondez `O`). Fermer le terminal arrête aussi tout. Vos tables
sont conservées dans `server/.data/postgres` : la prochaine fois, relancez simplement `npm run dev`. Pour tout effacer :
`npm run db:reset`.

### Vérifier l'installation (facultatif)

Aucune base n'est à démarrer : chaque test lance la sienne. Cette commande vérifie les types, le lint, la compilation puis
lance tous les tests (deux à quatre minutes) :

```bash
npm run verify
```

---

## Variantes

### Changer de modèle d'IA

Ajoutez dans `server/.env` l'identifiant d'un modèle servi par OpenRouter ([liste](https://openrouter.ai/models)), puis
relancez `npm run dev` :

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

La base `DB_NAME` doit exister. C'est la solution sur un PC Windows à processeur ARM, ou pour lancer l'application en root
(conteneur, serveur partagé) sans utilisateur système `postgres`.

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

Regardez toujours **le terminal où tourne `npm run dev`** : il contient la cause réelle, que l'interface résume en une
ligne. Les lignes `[api]` viennent de l'API, les lignes `[ui]` de l'interface.

| Ce que vous voyez | Cause probable | Que faire |
|---|---|---|
| `git`, `node` ou `npm` « n'est pas reconnu » / `command not found` | L'outil n'est pas installé, ou le terminal a été ouvert avant son installation | Installez-le ([étape 0](#0-ce-quil-faut-avoir)), puis ouvrez un nouveau terminal |
| `npm` : « l'exécution de scripts est désactivée sur ce système » (Windows) | PowerShell bloque les scripts par défaut | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, ou tapez `npm.cmd` au lieu de `npm` |
| `Node.js 22 or later is needed` | Node.js est trop ancien | Installez la version LTS depuis [nodejs.org](https://nodejs.org/fr/download) |
| `server/.env is missing` | Le fichier de configuration n'existe pas | `cp server/.env.sample server/.env` ([étape 2](#2-renseigner-votre-clé-openrouter)) |
| `Failed to start server: OPENROUTER_API_KEY is not set` | La clé est vide ou absente de `server/.env` | Renseignez-la (étape 2) et relancez. `OPENAI_API_KEY` n'est plus lue |
| `the Microsoft Visual C++ Redistributable (x64) is missing` (Windows), parfois précédé d'une fenêtre « VCRUNTIME140.dll introuvable » | Un composant Windows dont PostgreSQL a besoin manque | Installez [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe) et relancez |
| `There is no embedded PostgreSQL for this system (win32 arm64)` | PC Windows à processeur ARM | Utilisez [votre propre PostgreSQL](#votre-propre-postgresql) |
| `The PostgreSQL programs for this system … are not installed` | Les dépendances sont incomplètes (dossier copié depuis un autre système, installation interrompue) | `npm run setup`, puis relancez |
| `Failed to start server: Port … is already used by another program` | Un autre programme occupe le port de l'API (3000) ou de la base (54329) | Fermez-le, ou changez `PORT` (API ; l'interface suit) ou `DB_PORT` (base) dans `server/.env` |
| `The interface stopped: stopping the API` | En général, un autre programme occupe le port de l'interface (5173) : la ligne `[ui]` juste au-dessus le dit | Fermez-le, ou lancez sur un autre port : `$env:UI_PORT=5174; npm run dev` (PowerShell) ou `UI_PORT=5174 npm run dev` (macOS, Linux) |
| `A PostgreSQL server is already listening on port … but rejected the user` | Un autre PostgreSQL occupe ce port avec d'autres identifiants | Changez `DB_PORT`, ou alignez `DB_USER` et `DB_PASSWORD` |
| `PostgreSQL cannot run as root` | Vous êtes root (macOS, Linux) | Lancez avec un utilisateur normal, ou utilisez [votre propre PostgreSQL](#votre-propre-postgresql) |
| `Could not start the embedded PostgreSQL …` (autre cause) | Le dossier de données n'est pas utilisable | Lisez la fin du message et le journal de la base, `server/.data/postgres/postgres.log`. Si les données sont inutiles : `npm run db:reset`. Sinon `DB_DATA_DIR` vers un dossier où vous pouvez écrire |
| L'interface affiche `Failed to fetch` | L'API n'est pas démarrée ou n'est pas à l'adresse attendue | Vérifiez le terminal de `npm run dev` ; l'API répond sur `http://127.0.0.1:3000` (une page « 404 » à cette adresse est normale : elle n'a pas de page d'accueil) |
| `Failed to process CSV file` ou `Failed to process query` | Échec de l'appel au modèle, ou d'une étape interne | Lisez le terminal. `401` : clé refusée. `402` : plus de crédit OpenRouter. `429` : trop de requêtes. Un identifiant de modèle inconnu : vérifiez `LLM_MODEL` |
| `Invalid table name: …` | Le nom contient un caractère interdit | Voir les [règles de nom](#utiliser-linterface) |
| `A table named "…" already exists and was not created by this application` | Une table de ce nom existe déjà dans la base | Choisissez un autre nom |
| `Invalid CSV file: …` ou `CSV file is empty` | Le fichier est mal formé (nombre de colonnes différent selon les lignes) ou sans données | Corrigez le fichier |
| `Please choose a .csv file.` | Le fichier n'a pas l'extension `.csv` | Choisissez un fichier `.csv` |
| Les questions n'obtiennent pas de bonne réponse | Le modèle a mal compris la table | Reformulez en citant les noms de colonnes ; essayez un autre `LLM_MODEL` |
| La base reste active après un arrêt brutal (macOS, Linux : `kill -9`, plantage) | Le processus qui la gérait a disparu | Rien à faire : le prochain `npm run dev` la reprend et l'arrêtera. Sinon `npm run db:stop` |

---

## Commandes

Toutes se lancent depuis la racine du projet, de la même façon sous Windows, macOS et Linux. `npm run` seul les liste.
Celles qui en ont besoin installent d'abord les dépendances, puis les réinstallent quand elles changent (après un
`git pull`, par exemple).

| Commande | Rôle |
|---|---|
| `npm run dev` | Lance l'API (3000) avec sa base, puis l'interface (5173). Ctrl-C arrête tout ; si l'une des deux s'arrête, l'autre aussi. |
| `npm test` | Lance tous les tests (voir [Tests](#tests)), sans rien à démarrer avant. |
| `npm run check` | Vérifie les types, lance le lint et compile le serveur et l'interface. |
| `npm run verify` | `npm run check` puis `npm test`. |
| `npm run setup` | (Ré)installe les dépendances du serveur et de l'interface. |
| `npm run db:stop` | Arrête la base locale si un lancement précédent l'a laissée active. |
| `npm run db:reset` | Arrête la base locale et **supprime ses données** (toutes les tables importées), dans `server/.data/postgres` ou `DB_DATA_DIR`. Seul un dossier de données PostgreSQL est supprimé. |
| `npm run clean` | Supprime les fichiers compilés. |

Plus fines : `npm run test:unit`, `test:integration`, `test:ui`, `test:scripts`, `typecheck`, `lint`, `build`.

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
| `DB_DATA_DIR` | `server/.data/postgres` | Où la base embarquée garde ses données (sous Windows, écrivez par exemple `C:/data/sqlgen`). |
| `PORT` | `3000` | Port de l'API. `npm run dev` y fait pointer l'interface. |
| `API_HOST` | `127.0.0.1` | Adresse d'écoute de l'API : la machine locale seulement. `0.0.0.0` l'ouvre au réseau (voir [Sécurité](#sécurité)). |
| `DB_READONLY_USER` / `DB_READONLY_PASSWORD` | — | Rôle SQL en lecture seule pour les requêtes écrites par le modèle (facultatif, voir [Sécurité](#sécurité)). |

Deux réglages de `npm run dev` se donnent au lancement, pas dans `server/.env` : `UI_PORT` (port de l'interface, `5173`
par défaut) et `VITE_API_URL` (adresse de l'API appelée par l'interface, si ce n'est pas celle que `npm run dev` lance).
Par exemple : `$env:UI_PORT=5174; npm run dev` (PowerShell) ou `UI_PORT=5174 npm run dev` (macOS, Linux).

---

## Fonctionnement

![AI SQL Query Generator Architecture](./architecture.png)

- **Interface** (`ui/`) : React, TypeScript et composants shadcn/ui. Elle envoie les CSV et les questions à l'API.
- **API** (`server/src`) : Express, TypeScript et PostgreSQL. Elle appelle le modèle d'IA par une API compatible OpenAI
  (OpenRouter par défaut).
- **Racine** : `package.json` et `scripts/project.mjs` (les commandes `npm run …`), `data/` (CSV d'exemple).

**La base de données.** Au démarrage, l'API lance un vrai serveur PostgreSQL 18, dont les programmes sont fournis par des
paquets npm (`@embedded-postgres/<système>`, un par système d'exploitation et processeur). Elle le démarre et l'arrête avec
`pg_ctl`, l'outil de PostgreSQL : l'arrêt est propre sur tous les systèmes, Windows compris. La base écoute **uniquement sur
la machine locale**, stocke le texte en UTF-8 et garde ses données dans `server/.data/postgres`, avec son journal
(`postgres.log`). L'API l'arrête quand elle s'arrête (Ctrl-C, fermeture du terminal, `npm run dev` qui s'arrête). Sous macOS et
Linux, une base restée active après un arrêt brutal est reprise et arrêtée au lancement suivant ; sous Windows, elle
s'arrête avec l'API. Un PostgreSQL qui n'est pas le sien n'est jamais arrêté. Lancez un seul serveur par dossier de données.

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
avec un client PostgreSQL (pgAdmin, DBeaver, psql…) connecté en `DB_USER` à la base de l'application (`127.0.0.1`, port
`54329`, base `sqlgen` par défaut) :

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
OpenRouter, sans filtrage. L'API et la base ne sont joignables que depuis la machine locale. Si vous ouvrez l'API au réseau
(`API_HOST=0.0.0.0`), n'importe qui sur ce réseau peut l'utiliser, sans authentification : ne le faites que sur un réseau de
confiance. Changez les identifiants par défaut de la base (`postgres` / `admin`) si la machine est partagée.

## Tests

`npm test` lance tout, sans rien à installer ni à démarrer avant. Détail :

| Commande | Ce qu'elle lance |
|---|---|
| `npm run test:unit` | Serveur, fonctions pures : configuration, gardes sur les noms de table et le SQL, détection des types CSV, lecture des réponses du modèle, messages propres à chaque système |
| `npm run test:integration` | Serveur, les vraies routes, le SQL et le pipeline : imports et injection SQL, garde en lecture seule, rôle dédié, appels au fournisseur d'IA, cycle de vie de la base, processus serveur, `db:stop` et `db:reset` |
| `npm run test:ui` | Interface : tests de composants (Vitest et Testing Library, avec l'API remplacée par un faux `fetch`) |
| `npm run test:scripts` | `npm run dev` lui-même : ordre de démarrage, arrêt de l'ensemble (Ctrl-C, fermeture, échec de l'une des parties) |

Les tests n'appellent jamais OpenRouter : l'application parle à un faux local (`server/test/helpers/fake-openai.ts`), donc
pas de clé ni de coût. Chaque fichier de test lance **son propre PostgreSQL** (le même que celui de l'application), sur un
port libre et dans un dossier temporaire, puis le supprime : votre base et votre `server/.env` ne sont jamais utilisés.
`TEST_VERBOSE=1` affiche les journaux de l'application. Si une exécution est interrompue de force, des dossiers `sqlgen-*`
peuvent rester dans le dossier temporaire du système (`%TEMP%` sous Windows) : supprimez-les à la main.

Sous Windows, les tests qui envoient des signaux Unix (Ctrl-C simulé, `kill`) sont ignorés : Windows n'en a pas. L'arrêt
y est vérifié par le message que `npm run dev` envoie à l'API.

## Contribuer

Il s'agit d'une preuve de concept, non destinée à la production. Ce dépôt est à visée pédagogique et ne sera pas
maintenu : n'hésitez pas à le dupliquer (fork) et à le faire évoluer.

## Licence

Licence MIT : réutilisez ce code librement pour vos propres projets.
