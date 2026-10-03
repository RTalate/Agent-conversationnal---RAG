# Everything is driven from here: run `make` to list the commands.
.DEFAULT_GOAL := help
.PHONY: help install dev test test-unit test-integration test-ui typecheck lint build check verify db-up db-down db-reset clean

help: ## List the commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  make %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Dependencies are installed on first use, and again whenever a lockfile changes.
server/node_modules: server/package-lock.json
	cd server && npm ci
	@touch $@

ui/node_modules: ui/package-lock.json
	cd ui && npm ci
	@touch $@

install: server/node_modules ui/node_modules ## Install the dependencies of the server and of the UI

dev: server/node_modules ui/node_modules ## Start the API (3000) and the UI (5173); Ctrl-C stops both
	@scripts/dev.sh

test-unit: server/node_modules ## Server unit tests (no database needed)
	cd server && npm run test:unit

test-integration: server/node_modules ## Server integration tests (need PostgreSQL, see README)
	cd server && npm run test:integration

test-ui: ui/node_modules ## UI component tests
	cd ui && npm test

# Runs every suite even if one fails, then reports: a missing database does not hide a UI failure.
test: ## Run all the tests
	@$(MAKE) --no-print-directory -k test-unit test-integration test-ui

typecheck: server/node_modules ui/node_modules ## Type-check the server (src and tests) and the UI
	cd server && npm run typecheck
	cd ui && npx tsc -b

lint: ui/node_modules ## Lint the UI
	cd ui && npm run lint

build: server/node_modules ui/node_modules ## Build the server and the UI
	cd server && npm run build
	cd ui && npm run build

check: typecheck lint build ## Type-check, lint and build

verify: check test ## Everything: check, then all the tests

db-up: ## Start PostgreSQL in Docker, matching server/.env.sample
	docker compose up -d --wait db

db-down: ## Stop the PostgreSQL container (the data is kept)
	docker compose down

db-reset: ## Stop the PostgreSQL container and delete its data
	docker compose down --volumes

clean: ## Remove build output
	rm -rf server/dist ui/dist ui/*.tsbuildinfo
