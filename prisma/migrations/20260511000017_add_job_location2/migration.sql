-- Optional second location for jobs that hire across two cities (e.g. Wellington
-- + Christchurch). The scoring pipeline joins location + location2 with " / "
-- and feeds that to assessLocationFit, which already understands multi-target
-- location strings — so a candidate in either metro scores 100.
ALTER TABLE "Job" ADD COLUMN "location2" TEXT;
