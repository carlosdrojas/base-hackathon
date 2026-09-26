# Base Hackathon

Solidity smart contracts for the Base hackathon, built with [Hardhat 3](https://hardhat.org) + TypeScript, targeting [Base](https://base.org) (mainnet) and Base Sepolia (testnet).

## Setup

```bash
npm install
cp .env.example .env   # fill in PRIVATE_KEY and RPC URLs
```

## Commands

```bash
npm run compile
npm test
npm run deploy:baseSepolia
npm run deploy:baseMainnet
```

## Networks

| Network | Chain ID | RPC |
|---|---|---|
| Base Sepolia | 84532 | https://sepolia.base.org |
| Base Mainnet | 8453 | https://mainnet.base.org |

Get Base Sepolia testnet ETH from the [Base faucet](https://docs.base.org/tools/network-faucets).
