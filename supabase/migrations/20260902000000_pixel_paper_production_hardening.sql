-- Pixel Paper production hardening
--
-- Apply this migration to the existing runtime database before deploying the
-- application build that reads pixel_bookings.expires_at. It does not touch
-- paid or cancelled booking history.

-- Durable pending-hold deadline. The application writes this for every new
-- booking; this backfill only concerns rows still pending.
ALTER TABLE public.pixel_bookings
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE public.pixel_bookings
   SET expires_at = created_at + make_interval(mins => 20)
 WHERE status = 'pending'
   AND expires_at IS NULL;

CREATE INDEX IF NOT EXISTS pixel_bookings_pending_expiry_idx
  ON public.pixel_bookings (expires_at)
  WHERE status = 'pending';

-- Raw advertisement rows are private. Public newspaper rendering goes through
-- the server's paid-and-approved join in repository.ts.
ALTER TABLE public.advertisements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.advertisements FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Public can read approved advertisements"
  ON public.advertisements;
DROP POLICY IF EXISTS "Pixel Paper: deny direct advertisement access"
  ON public.advertisements;
CREATE POLICY "Pixel Paper: deny direct advertisement access"
  ON public.advertisements FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
