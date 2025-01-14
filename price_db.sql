CREATE TABLE price_data ( 
    timestamp TIMESTAMP,
    symbol TEXT,
    ticker TEXT
    open FLOAT,
    high FLOAT,
    low FLOAT,
    close FLOAT,
    volume FLOAT,
);

SELECT create_hypertable('price_data', 'timestamp');


