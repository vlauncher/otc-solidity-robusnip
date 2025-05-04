# P2P Token Escrow Smart Contract

This Solidity smart contract facilitates peer-to-peer token trading with an escrow mechanism. It supports both fixed and dynamic pricing models, integrates with Uniswap V3 for dynamic price feeds, and includes a dispute resolution system.

## Features

- **Listing Creation:** Sellers can list tokens for sale with customizable parameters.
- **Trade Initiation:** Buyers can purchase tokens from listings, with automatic price calculation.
- **Pricing Models:**
  - **Fixed Pricing:** Set a fixed price per token.
  - **Dynamic Pricing:** Use real-time market data from Uniswap V3, with optional discounts.
- **Escrow System:** Securely holds tokens and payments until trade completion.
- **Dispute Resolution:** Allows for disputes to be raised and resolved by the contract owner.
- **Security:** Implements reentrancy protection and safe token transfers using OpenZeppelin contracts.

## Prerequisites

- Node.js (v14 or later)
- npm (v6 or later)
- Hardhat (configured in the project)

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd <repository-directory>
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

To interact with the contract, you can use Hardhat scripts or directly through ethers.js in your application. Below are some example interactions:

### Create a Listing

```javascript
const listingId = await contract.createListing(
  tokenAddress,
  totalAmount,
  pricingType, // 0 for FIXED, 1 for DYNAMIC
  fixedPricePerToken,
  discountBps,
  paymentAssetAddress,
  priceFeedAddress
);
```

**Note:** When using dynamic pricing, ensure that the `priceFeed` address is a Uniswap V3 pool where `tokenOffered` is token0 and `paymentAsset` is token1. If the tokens are in reverse order, the price calculation may need to be adjusted.

### Initiate a Trade

```javascript
const tradeId = await contract.initiateTrade(listingId, tokenAmount);
```

**Note:** Trades must be initiated within 120 blocks (approximately 30 minutes) of the listing creation. After this period, the listing is considered expired.

### Seller Release

```javascript
await contract.sellerRelease(tradeId);
```

### Raise a Dispute

```javascript
await contract.raiseDispute(tradeId);
```

**Note:** A dispute can only be raised if more than 120 blocks (approximately 30 minutes) have passed since the trade was initiated.

### Resolve a Dispute

```javascript
await contract.resolveDispute(tradeId, refundBuyer);
```

## Contract Administration

The contract owner has special privileges to manage certain aspects of the contract:

- **Set Payment Asset:** Allow or disallow specific ERC20 tokens to be used as payment assets.
  ```javascript
  await contract.setPaymentAsset(assetAddress, allowed);
  ```

- **Revoke Payment Asset:** Specifically revoke a payment asset.
  ```javascript
  await contract.revokePaymentAsset(assetAddress);
  ```

- **Confirm Dispute Resolution:** Confirm the resolution of a dispute.
  ```javascript
  await contract.confirmDisputeResolution(tradeId);
  ```

- **Resolve Dispute:** After confirmation, resolve the dispute by deciding whether to refund the buyer or complete the trade.
  ```javascript
  await contract.resolveDispute(tradeId, refundBuyer);
  ```

## Events

The contract emits the following events:

- **ListingCreated(uint256 indexed id, address indexed seller):** Emitted when a new listing is created.
- **TradeInitiated(uint256 indexed tradeId, uint256 indexed listingId, address indexed buyer):** Emitted when a buyer initiates a trade.
- **SellerReleased(uint256 indexed tradeId):** Emitted when the seller releases the tokens to the buyer.
- **TradeDisputed(uint256 indexed tradeId):** Emitted when a dispute is raised for a trade.
- **TradeResolved(uint256 indexed tradeId, bool inFavorOfBuyer):** Emitted when a dispute is resolved.

These events can be used to monitor the contract's activity and update the user interface accordingly.

## Deployment

The contract can be deployed to various networks using Hardhat. Ensure you have the necessary private keys and network configurations set up in your `.env` file or Hardhat config.

### Deploy to Localhost

```bash
npx hardhat run scripts/deploy.js --network localhost
```

### Deploy to BSC Testnet

```bash
npx hardhat run scripts/deploy.js --network bscTestnet
```

### Deploy to BSC Mainnet

```bash
npx hardhat run scripts/deploy.js --network bscMainnet
```

### Deploy to Ethereum Mainnet

```bash
npx hardhat run scripts/deploy.js --network mainnet
```

## Testing

Run the test suite using Hardhat:

```bash
npx hardhat test
```

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with your changes.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.