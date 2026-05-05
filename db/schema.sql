-- ============================================================
-- mitre-supply-threat-watch  |  Snowflake DDL
-- Schema: THREAT_SUPPLY_DB.PUBLIC
-- ============================================================

CREATE DATABASE IF NOT EXISTS THREAT_SUPPLY_DB;
USE DATABASE THREAT_SUPPLY_DB;
CREATE SCHEMA IF NOT EXISTS PUBLIC;

-- -----------------------------------------------------------
-- Head 1: Threat Intelligence tables
-- -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS mitre_techniques (
    technique_id    VARCHAR(20)  NOT NULL,
    technique_name  VARCHAR(200) NOT NULL,
    description     VARCHAR(2000),
    tactics         VARCHAR(500),
    platforms       VARCHAR(500),
    data_sources    VARCHAR(1000),
    stix_id         VARCHAR(100),
    url             VARCHAR(300),
    loaded_at       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (technique_id)
);

CREATE TABLE IF NOT EXISTS mitre_groups (
    group_id    VARCHAR(20)  NOT NULL,
    group_name  VARCHAR(200),
    aliases     VARCHAR(500),
    description VARCHAR(1000),
    stix_id     VARCHAR(100),
    loaded_at   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (group_id)
);

CREATE TABLE IF NOT EXISTS mitre_software (
    software_id   VARCHAR(20)  NOT NULL,
    software_name VARCHAR(200),
    software_type VARCHAR(20),
    platforms     VARCHAR(500),
    description   VARCHAR(1000),
    stix_id       VARCHAR(100),
    loaded_at     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (software_id)
);

CREATE TABLE IF NOT EXISTS cisa_kev (
    cve_id          VARCHAR(30)  NOT NULL,
    vendor          VARCHAR(200),
    product         VARCHAR(200),
    vuln_name       VARCHAR(400),
    date_added      DATE,
    description     VARCHAR(2000),
    required_action VARCHAR(1000),
    due_date        DATE,
    is_ransomware   BOOLEAN DEFAULT FALSE,
    year            INTEGER,
    quarter         INTEGER,
    year_month      VARCHAR(10),
    loaded_at       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (cve_id)
);

CREATE TABLE IF NOT EXISTS nvd_cves (
    cve_id          VARCHAR(30)   NOT NULL,
    description     VARCHAR(2000),
    published       TIMESTAMP_NTZ,
    last_modified   TIMESTAMP_NTZ,
    status          VARCHAR(50),
    cvss_base_score FLOAT,
    cvss_severity   VARCHAR(20),
    cwe             VARCHAR(200),
    vendors         VARCHAR(500),
    products        VARCHAR(500),
    year_month      VARCHAR(10),
    loaded_at       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (cve_id)
);

CREATE TABLE IF NOT EXISTS cve_entities (
    id           INTEGER AUTOINCREMENT,
    cve_id       VARCHAR(30),
    entity_text  VARCHAR(300),
    entity_label VARCHAR(30),
    loaded_at    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (id),
    FOREIGN KEY (cve_id) REFERENCES nvd_cves(cve_id)
);

CREATE TABLE IF NOT EXISTS cve_topics (
    cve_id           VARCHAR(30),
    dominant_topic   INTEGER,
    topic_probability FLOAT,
    loaded_at        TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (cve_id)
);

CREATE TABLE IF NOT EXISTS cve_ttp_tags (
    cve_id          VARCHAR(30),
    technique_id    VARCHAR(20),
    technique_name  VARCHAR(200),
    tactic          VARCHAR(100),
    similarity_score FLOAT,
    rank            INTEGER,
    keyword_match   BOOLEAN,
    loaded_at       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (cve_id, rank)
);

CREATE TABLE IF NOT EXISTS cve_ttp_graph_edges (
    source      VARCHAR(100),
    target      VARCHAR(100),
    edge_type   VARCHAR(50),
    weight      FLOAT,
    is_kev      BOOLEAN DEFAULT FALSE,
    loaded_at   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- -----------------------------------------------------------
-- Head 2: Supply chain & forecasting tables
-- -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS fred_series (
    period                              DATE NOT NULL,
    year_month                          VARCHAR(10),
    global_supply_chain_pressure_index  FLOAT,
    retail_sales_excl_food              FLOAT,
    retail_food_services                FLOAT,
    cpi_all_urban                       FLOAT,
    nonfarm_payrolls                    FLOAT,
    inventory_sales_ratio               FLOAT,
    loaded_at                           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (period)
);

CREATE TABLE IF NOT EXISTS census_retail (
    period              DATE NOT NULL,
    year_month          VARCHAR(10),
    total_retail_food   FLOAT,
    motor_vehicles      FLOAT,
    building_materials  FLOAT,
    food_beverage       FLOAT,
    clothing_accessories FLOAT,
    sporting_hobby      FLOAT,
    general_merchandise FLOAT,
    department_stores   FLOAT,
    nonstore_retailers  FLOAT,
    food_services       FLOAT,
    loaded_at           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (period)
);

CREATE TABLE IF NOT EXISTS retail_forecasts (
    period          DATE,
    year_month      VARCHAR(10),
    category        VARCHAR(100),
    target          FLOAT,
    forecast        FLOAT,
    forecast_lower  FLOAT,
    forecast_upper  FLOAT,
    residual        FLOAT,
    is_anomaly      BOOLEAN DEFAULT FALSE,
    loaded_at       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (period, category)
);

CREATE TABLE IF NOT EXISTS anomaly_events (
    period               DATE,
    year_month           VARCHAR(10),
    anomaly_label        VARCHAR(500),
    cross_anomaly_score  FLOAT,
    loaded_at            TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (period)
);

-- -----------------------------------------------------------
-- Derived view: threat_supply_monthly
-- Joins CVE monthly counts with retail / FRED for correlation analysis
-- -----------------------------------------------------------

CREATE OR REPLACE VIEW threat_supply_monthly AS
SELECT
    f.period,
    f.year_month,
    f.global_supply_chain_pressure_index,
    f.inventory_sales_ratio,
    c.total_retail_food,
    c.nonstore_retailers,
    c.clothing_accessories,
    COUNT(DISTINCT n.cve_id)                              AS cve_count,
    COUNT(DISTINCT k.cve_id)                              AS kev_count,
    SUM(CASE WHEN n.cvss_severity = 'CRITICAL' THEN 1 ELSE 0 END) AS critical_cves,
    AVG(n.cvss_base_score)                               AS avg_cvss,
    SUM(CASE WHEN k.is_ransomware THEN 1 ELSE 0 END)     AS ransomware_kevs
FROM fred_series f
LEFT JOIN census_retail c  ON f.year_month = c.year_month
LEFT JOIN nvd_cves n       ON f.year_month = n.year_month
LEFT JOIN cisa_kev k       ON f.year_month = k.year_month
GROUP BY 1, 2, 3, 4, 5, 6, 7
ORDER BY 1;
