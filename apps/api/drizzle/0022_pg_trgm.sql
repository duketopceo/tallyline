-- Plan import (U9, KTD4): title similarity for the ambiguous-match layer.
-- pg_trgm ships with the stock postgres image and is a trusted extension, so
-- the database owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
