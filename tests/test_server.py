"""Tests for server.py API endpoints."""

import os
from unittest.mock import MagicMock, patch

import httpx
import pytest


@pytest.fixture
def app():
    """Create app with mocked dependencies."""
    with patch.dict(os.environ, {"PROD": "false"}):
        with patch("server.UserSettings") as mock_settings:
            mock_settings.return_value.public_key = "0xTestPublicKey123"
            with patch("server.Trader"):
                from importlib import reload

                import server

                reload(server)
                yield server.app


@pytest.fixture
async def client(app):
    """Create async test client."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


class TestWalletSettingsEndpoint:
    """Tests for GET /api/hyperliquid/wallet-settings."""

    @pytest.mark.anyio
    async def test_get_wallet_settings_returns_public_key(self, client):
        with patch("server.UserSettings") as mock_settings:
            mock_settings.return_value.public_key = "0xTestPublicKey123"
            response = await client.get("/api/hyperliquid/wallet-settings")
            assert response.status_code == 200
            data = response.json()
            assert "public_key" in data
            assert "is_testnet" in data
            assert data["public_key"] == "0xTestPublicKey123"

    @pytest.mark.anyio
    async def test_get_wallet_settings_testnet_mode(self, client):
        with patch("server.UserSettings") as mock_settings:
            mock_settings.return_value.public_key = "0xTestKey"
            response = await client.get("/api/hyperliquid/wallet-settings")
            assert response.status_code == 200
            data = response.json()
            assert data["is_testnet"] is True

    @pytest.mark.anyio
    async def test_get_wallet_settings_mainnet_mode(self, app):
        with patch.dict(os.environ, {"PROD": "true"}):
            with patch("server.UserSettings") as mock_settings:
                mock_settings.return_value.public_key = "0xTestKey"
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(
                    transport=transport, base_url="http://test"
                ) as test_client:
                    response = await test_client.get("/api/hyperliquid/wallet-settings")
                    assert response.status_code == 200
                    data = response.json()
                    assert data["is_testnet"] is False


class TestNetworkSwitchEndpoint:
    """Tests for POST /api/hyperliquid/network."""

    @pytest.mark.anyio
    async def test_switch_to_testnet(self, client):
        response = await client.post(
            "/api/hyperliquid/network",
            json={"is_testnet": True},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["is_testnet"] is True
        assert os.environ.get("PROD") == "false"

    @pytest.mark.anyio
    async def test_switch_to_mainnet(self, client):
        response = await client.post(
            "/api/hyperliquid/network",
            json={"is_testnet": False},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["is_testnet"] is False
        assert os.environ.get("PROD") == "true"

    @pytest.mark.anyio
    async def test_switch_network_reloads_trader(self, client):
        with patch("server.reload_trader") as mock_reload:
            response = await client.post(
                "/api/hyperliquid/network",
                json={"is_testnet": True},
            )
            assert response.status_code == 200
            mock_reload.assert_called_once()

    @pytest.mark.anyio
    async def test_switch_network_invalid_payload(self, client):
        response = await client.post(
            "/api/hyperliquid/network",
            json={},
        )
        assert response.status_code == 422

    @pytest.mark.anyio
    async def test_no_secret_key_in_network_endpoint(self, client):
        response = await client.post(
            "/api/hyperliquid/network",
            json={"is_testnet": True, "secret_key": "should_be_ignored"},
        )
        assert response.status_code == 200


class TestSecretKeyNotExposed:
    """Verify that secret key cannot be set via API."""

    @pytest.mark.anyio
    async def test_no_wallet_settings_post_endpoint(self, client):
        response = await client.post(
            "/api/hyperliquid/wallet-settings",
            json={"public_key": "0x123", "secret_key": "secret", "is_testnet": True},
        )
        assert response.status_code in (404, 405)

    @pytest.mark.anyio
    async def test_network_endpoint_does_not_accept_secret_key_field(self, client):
        response = await client.post(
            "/api/hyperliquid/network",
            json={"is_testnet": True},
        )
        assert response.status_code == 200
        assert "secret_key" not in response.json()


class TestBudgetPreferenceEndpoint:
    """Tests for budget preference endpoints."""

    @pytest.mark.anyio
    async def test_get_budget_preference_default(self, client):
        with patch("server.BUDGET_PREFERENCE_FILE") as mock_file:
            mock_file.exists.return_value = False
            response = await client.get("/api/hyperliquid/budget-preference")
            assert response.status_code == 200
            assert response.json()["budget"] == 0.0

    @pytest.mark.anyio
    async def test_save_budget_preference(self, client):
        with patch("server.BUDGET_PREFERENCE_FILE") as mock_file:
            mock_file.parent.mkdir = MagicMock()
            mock_file.open = MagicMock()
            response = await client.post(
                "/api/hyperliquid/budget-preference",
                json={"budget": 1000.0},
            )
            assert response.status_code == 200
            assert response.json()["success"] is True
