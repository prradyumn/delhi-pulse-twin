.PHONY: help setup spike data test assets qa qa-shots qa-render dev build preview budget check clean

PY := .venv/bin/python
BLENDER := /Applications/Blender.app/Contents/MacOS/Blender
HEADLESS := $(BLENDER) --background --factory-startup --python

help:
	@echo "  setup      create the pipeline venv and install web deps"
	@echo "  spike      re-run the Spike-0 audits (cached; delete spike/_raw to refetch)"
	@echo "  data       OSM extract -> versioned runtime data, then check its invariants"
	@echo "  test       data invariants only (bounds, provenance, corridors, scenario model)"
	@echo "  assets     headless Blender: hero landmark LODs -> GLB (budget-gated)"
	@echo "  qa-render  headless contact-sheet renders for visual review"
	@echo "  dev        web app dev server"
	@echo "  build      typecheck + production build"
	@echo "  qa         browser QA: renders, frame time, scenarios, FR-01 degradation"
	@echo "  budget     fail if any asset or transfer budget is breached"
	@echo "  check      data + build + budget, in that order"

setup:
	/opt/homebrew/bin/python3.12 -m venv .venv
	.venv/bin/pip install -q --upgrade pip
	.venv/bin/pip install -q pyproj shapely
	cd web && npm install

spike:
	python3 spike/osm_audit.py
	python3 spike/osm_fetch.py
	$(PY) spike/analyze.py
	$(PY) spike/bus_routes.py
	$(PY) spike/corridor_pick.py

data:
	$(PY) pipeline/fetch_landmarks.py
	$(PY) pipeline/src/dpt/build.py
	$(PY) pipeline/tests/test_outputs.py

test:
	$(PY) pipeline/tests/test_outputs.py

# Blender's remaining job after the Spike-0 bake-off: hero landmarks only.
# Ordinary buildings are extruded at runtime — see docs/06-SPIKE-0-BAKEOFF.md.
assets:
	$(HEADLESS) blender/scripts/25_landmark_models.py -- \
	  --config config/study-area.json --out web/public/data/@v1/landmarks

# Kept as the fallback: plain massing extruded from each footprint, no parametric form. Useful if
# a builder in 25_ regresses and you need correctly-placed blocks back in one command.
assets-massing:
	$(HEADLESS) blender/scripts/20_landmark_export.py -- \
	  --config config/study-area.json --out web/public/data/@v1/landmarks

qa-render:
	$(HEADLESS) blender/scripts/30_qa_render.py -- --out spike/results/qa

# Kept as the measured alternative to runtime extrusion. Deleting it would delete the evidence.
bake-buildings:
	$(HEADLESS) blender/scripts/10_build_buildings.py -- \
	  --in web/public/data/@v1/buildings.json --out web/public/data/@v1/buildings.glb

dev:
	cd web && npm run dev

build:
	cd web && npm run build

preview:
	cd web && npm run preview

qa:
	cd web && npm run build && node tools/qa.mjs

qa-shots:
	cd web && npm run build && node tools/qa.mjs --shots

budget:
	cd web && node tools/budget.mjs

check: data build
	cd web && node tools/budget.mjs --dist
	cd web && node tools/qa.mjs

clean:
	rm -rf web/dist web/node_modules/.vite
