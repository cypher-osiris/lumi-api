-- Seed: Lumi's real paid buys on 2026-10-22 (wallet rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM). All tesSUCCESS on XRPL mainnet.
INSERT OR IGNORE INTO observations (vendor_id, endpoint, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, source) VALUES
('scalpstream', 'https://feed.scalpstream.com/crypto', 1792673230000, 'xrpl:0', '579DA9D42E89594F38A278885DF61D7549DE53DA2045D104874AD85E152EF9A5', '0.007548', 'XRP', 200, 1, NULL,
 'Paid 0.007548 XRP; HTTP 200; response contained data (ranked list of crypto candidates). No PAYMENT-RESPONSE header was returned.', 'lumi_buy'),
('asksurf', 'https://x402.asksurf.ai/x402/xrpl/data/v1/news/feed', 1792673530000, 'xrpl:0', 'FEE22376B67B394D997BE95E3D585C7143A36657C74B7D6926495CEA74CCD163', '0.006', 'RLUSD', 502, 0, NULL,
 'Paid 0.006 RLUSD; HTTP 502; response contained no data (body: error "surf_upstream_error", upstream_status 401).', 'lumi_buy'),
('asksurf', 'https://x402.asksurf.ai/x402/xrpl/data/v1/news/feed', 1792673600000, 'xrpl:0', '134C85B67820077D4CAD2501C680A70B8D78BE076D7BEA558A5017F1B51B78D5', '0.006', 'RLUSD', 502, 0, NULL,
 'Paid 0.006 RLUSD; HTTP 502; response contained no data (body: error "surf_upstream_error", upstream_status 401).', 'lumi_buy'),
('heurist-mesh', 'https://mesh.heurist.xyz/x402/xrpl/agents/FundingRateAgent/get_all_funding_rates', 1792673782000, 'xrpl:0', '07929A44333D9269CD4C92DE6A4A917B0BA28F1A3F244F1992B3F61BDA366BA0', '0.001', 'RLUSD', 200, 0, NULL,
 'Paid 0.001 RLUSD; HTTP 200; response contained an empty result (rates: []).', 'lumi_buy');
