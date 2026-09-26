
.PHONY: migrate migrate-appeal test test-appeal run run-appeal up

migrate:
	npm run migrate

migrate-appeal:
	npm --prefix appeal run migrate

test:
	npm test

test-appeal:
	npm --prefix appeal test

run:
	npm start

run-appeal:
	PORT=8090 APPEAL_DATABASE_PATH=$(PWD)/appeal/data/appeal.sqlite3 \
	ENGINE_BASE_URL=http://127.0.0.1:8080 npm --prefix appeal start

up:
	docker compose up --build
