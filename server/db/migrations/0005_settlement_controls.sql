CREATE UNIQUE INDEX settlements_ticket_leg_source_idx
  ON settlements (ticket_leg_id, source);

CREATE INDEX ticket_legs_status_idx ON ticket_legs (status);
CREATE INDEX tickets_status_idx ON tickets (status);
