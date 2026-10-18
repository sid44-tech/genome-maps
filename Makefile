.PHONY: setup data backend frontend test sample

setup:
	cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
	cd frontend && npm install

data:
	backend/scripts/fetch_data.sh
	cd backend && .venv/bin/python scripts/build_data.py
	cd backend && .venv/bin/python scripts/build_clinvar.py
	cd backend && .venv/bin/python scripts/build_plain.py

sample:
	cd backend && .venv/bin/python scripts/make_sample_dna.py ../samples/sample_23andme.txt

backend:
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

test:
	cd backend && .venv/bin/python -m pytest -q tests
	cd frontend && npx tsc -b && npx vitest run
