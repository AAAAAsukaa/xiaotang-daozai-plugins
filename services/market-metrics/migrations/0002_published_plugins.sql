-- 维护者从已发布目录核对后，按发布渠道登记插件及可计数版本。
INSERT INTO metric_plugins (channel, plugin_id) VALUES
    ('preview', 'daozai.lunar-today'),
    ('preview', 'example.payday'),
    ('preview', 'example.trip');

INSERT INTO metric_versions (channel, plugin_id, version) VALUES
    ('preview', 'daozai.lunar-today', '1.0.0'),
    ('preview', 'example.payday', '1.0.0'),
    ('preview', 'example.payday', '1.0.1'),
    ('preview', 'example.trip', '1.0.0');
