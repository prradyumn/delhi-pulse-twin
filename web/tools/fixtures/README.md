# QA fixtures

## `otd-vehicles-sample.pb`

Real bytes from the Delhi OTD GTFS-Realtime `VehiclePositions` feed, captured 2026-09-17 ~20:53
IST: a `FeedHeader` plus eleven whole `FeedEntity` records, one of which is inside the study box.

Whole top-level records are kept and concatenated. Top-level protobuf fields are
length-delimited and order-independent, so this is a valid `FeedMessage` in which **nothing has
been re-encoded** — that is the point. A fixture built by an encoder of ours would only ever
test our encoder against our decoder, and the bug this guards against was a decoder that agreed
with itself and disagreed with Delhi.

The feed timestamp is real and therefore ages, so the adapter reports the fixture as `stale`
rather than `live`. That is correct and the checks allow for it: `stale` still means *connected,
decoded, and carrying vehicles*, which is what is under test.

To regenerate (needs `OTD_API_KEY` and a daytime feed — the feed is legitimately empty at night):

    curl -s "https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=$OTD_API_KEY" -o feed.pb

then keep the header record and a handful of entity records, preferring any whose coordinates fall
inside the box in `config/study-area.json`.
