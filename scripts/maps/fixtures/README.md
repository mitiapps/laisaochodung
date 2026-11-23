# Map converter fixtures

`maps/fixture-osm/` is a synthetic, hand-written Overpass extract (not OpenStreetMap data) shaped
like `out body geom` output: a two-lane one-way street (way 1) with a marked crossing, crossed by
a two-way side road (way 3), turning left at a signalled node onto a two-way street (way 2), with a
side road continuing east (way 4). Tests build it to check the OSM path of the converter offline.
