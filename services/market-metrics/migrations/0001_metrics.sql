CREATE TABLE metric_plugins (
    channel TEXT NOT NULL CHECK (channel IN ('preview', 'stable')),
    plugin_id TEXT NOT NULL,
    downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
    favorites INTEGER NOT NULL DEFAULT 0 CHECK (favorites >= 0),
    PRIMARY KEY (channel, plugin_id)
) WITHOUT ROWID;

CREATE TABLE metric_versions (
    channel TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    version TEXT NOT NULL,
    PRIMARY KEY (channel, plugin_id, version),
    FOREIGN KEY (channel, plugin_id) REFERENCES metric_plugins (channel, plugin_id)
) WITHOUT ROWID;

CREATE TABLE metric_events (
    channel TEXT NOT NULL,
    event_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('download', 'favorite')),
    version TEXT,
    saved INTEGER,
    PRIMARY KEY (channel, event_id),
    FOREIGN KEY (channel, plugin_id) REFERENCES metric_plugins (channel, plugin_id),
    FOREIGN KEY (channel, plugin_id, version) REFERENCES metric_versions (channel, plugin_id, version),
    CHECK (
        (kind = 'download' AND version IS NOT NULL AND saved IS NULL)
        OR (kind = 'favorite' AND version IS NULL AND saved IS NOT NULL AND saved IN (0, 1))
    )
) WITHOUT ROWID;

CREATE TABLE metric_favorites (
    channel TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    PRIMARY KEY (channel, installation_id, plugin_id)
) WITHOUT ROWID;

CREATE TABLE metric_rate (
    channel TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    minute INTEGER NOT NULL,
    used INTEGER NOT NULL,
    PRIMARY KEY (channel, installation_id)
) WITHOUT ROWID;

CREATE TRIGGER metric_event_applied
AFTER INSERT ON metric_events
BEGIN
    INSERT INTO metric_rate (channel, installation_id, minute, used)
    VALUES (NEW.channel, NEW.installation_id, unixepoch() / 60, 1)
    ON CONFLICT(channel, installation_id) DO UPDATE SET
        used = CASE WHEN minute = excluded.minute THEN used + 1 ELSE 1 END,
        minute = excluded.minute;
    SELECT CASE WHEN (
        SELECT used FROM metric_rate
        WHERE channel = NEW.channel AND installation_id = NEW.installation_id
    ) > 120 THEN RAISE(ABORT, 'market_rate_limited') END;

    UPDATE metric_plugins SET downloads = downloads + 1
    WHERE NEW.kind = 'download' AND channel = NEW.channel AND plugin_id = NEW.plugin_id;

    UPDATE metric_plugins
    SET favorites = favorites + NEW.saved - EXISTS (
        SELECT 1 FROM metric_favorites
        WHERE channel = NEW.channel AND installation_id = NEW.installation_id AND plugin_id = NEW.plugin_id
    )
    WHERE NEW.kind = 'favorite' AND channel = NEW.channel AND plugin_id = NEW.plugin_id;

    INSERT INTO metric_favorites (channel, installation_id, plugin_id)
    SELECT NEW.channel, NEW.installation_id, NEW.plugin_id
    WHERE NEW.kind = 'favorite' AND NEW.saved = 1
    ON CONFLICT(channel, installation_id, plugin_id) DO NOTHING;

    DELETE FROM metric_favorites
    WHERE NEW.kind = 'favorite' AND NEW.saved = 0
        AND channel = NEW.channel AND installation_id = NEW.installation_id AND plugin_id = NEW.plugin_id;
END;
