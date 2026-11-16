-- A payment its payee would link to a fixed cost, marked by hand as plain spending (a game bought from the same
-- store as a subscription). commitment_pinned can't say "none": null there lets the payee decide.
ALTER TABLE transactions ADD COLUMN not_fixed boolean NOT NULL DEFAULT false;
