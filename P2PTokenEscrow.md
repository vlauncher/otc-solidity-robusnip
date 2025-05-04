# P2PTokenEscrow Contract Documentation

## Contract Overview

The P2PTokenEscrow contract is a Solidity smart contract designed to facilitate
peer-to-peer (P2P) trading of ERC20 tokens with an escrow mechanism to ensure
trust between buyers and sellers. It leverages OpenZeppelin libraries for
security and token management and integrates Uniswap V3 for dynamic pricing.
This documentation explains the contract's functions, their parameters, and usage
details.

The contract enables sellers to list ERC20 tokens for sale and buyers to purchase
them, with funds and tokens held in escrow until the trade is completed or
resolved. It supports two pricing models: fixed pricing and dynamic pricing based
on Uniswap V3 pool prices. A dispute resolution process, managed by the contract
owner, is included.

## Key Components

### Enums

#### PricingType

Defines the pricing mechanism for a listing.

* `FIXED`: A fixed price per token set by the seller.
* `DYNAMIC`: A price dynamically derived from a Uniswap V3 pool, with an
  optional discount.

#### TradeStatus

Represents the state of a listing or trade.

* `OPEN`: The listing is available for trading.
* `FUNDED`: All tokens in the listing have been purchased.
* `COMPLETED`: The trade has been successfully finalized.
* `CANCELLED`: The trade was cancelled, typically after dispute resolution.
* `DISPUTED`: The trade is under dispute.

### Structs

#### Listing

Represents a seller's offer to sell tokens.

* `seller`: Address of the seller.
* `tokenOffered`: ERC20 token being sold.
* `totalAmount`: Total amount of tokens offered.
* `remainingAmount`: Remaining tokens available for purchase.
* `pricingType`: Pricing type (FIXED or DYNAMIC).
* `fixedPricePerToken`: Price per token (for FIXED pricing).
* `discountBps`: Discount in basis points (for DYNAMIC pricing).
* `paymentAsset`: ERC20 token used for payment.
* `createdAtBlock`: Block number when the listing was created.
* `status`: Current status of the listing.
* `priceFeed`: Uniswap V3 pool address (for DYNAMIC pricing).

#### Trade

Represents a trade initiated by a buyer.

* `listingId`: ID of the associated listing.
* `buyer`: Address of the buyer.
* `tokenAmount`: Amount of tokens being purchased.
* `paymentAmount`: Amount of payment asset paid.
* `createdAtBlock`: Block number when the trade was initiated.
* `buyerConfirmed`: Whether the buyer has confirmed the trade.
* `sellerConfirmed`: Whether the seller has confirmed the trade.
* `disputed`: Whether the trade is in dispute.

## Constants

* `MAX_BLOCKS`: Set to 120 blocks (~30 minutes at 15 seconds per block), defining
  the time limit for trade actions.
* `REQUIRED_CONFIRMATIONS`: Set to 1, requiring only the owner's confirmation to
  resolve disputes.

## Events

* `ListingCreated(uint256 id, address seller)`: Emitted when a new listing is
  created.
* `TradeInitiated(uint256 tradeId, uint256 listingId, address buyer)`: Emitted
  when a trade is initiated.
* `SellerReleased(uint256 tradeId)`: Emitted when the seller releases tokens to
  the buyer.
* `TradeDisputed(uint256 tradeId)`: Emitted when a dispute is raised.
* `TradeResolved(uint256 tradeId, bool inFavorOfBuyer)`: Emitted when a dispute
  is resolved.

## Functions

### 1. `setPaymentAsset(address asset, bool allowed)`

Description: Allows the owner to add or remove a payment asset from the allowed
list.

Parameters:

* `asset`: Address of the ERC20 token.
* `allowed`: Boolean to allow (true) or disallow (false) the asset.


Access: Only the contract owner.
Usage: Call this to enable or disable an ERC20 token as a payment option.

### 2. `revokePaymentAsset(address asset)`

Description: Revokes a payment asset by setting its allowed status to false.
Parameters:

* `asset`: Address of the ERC20 token to revoke.


Access: Only the contract owner.
Usage: A convenience function to disable a payment asset.

### 3. `createListing(IERC20 token, uint256 totalAmount, PricingType pricingType, uint256 fixedPricePerToken, uint256 discountBps, IERC20 paymentAsset, address priceFeed)`

Description: Creates a new listing for selling tokens.
Parameters:

* `token`: ERC20 token to sell.
* `totalAmount`: Total amount of tokens to offer.
* `pricingType`: Pricing type (FIXED or DYNAMIC).
* `fixedPricePerToken`: Price per token (required if FIXED).
* `discountBps`: Discount in basis points (0-10000, required if DYNAMIC).
* `paymentAsset`: ERC20 token for payment (must be allowed).
* `priceFeed`: Uniswap V3 pool address (required if DYNAMIC).


Requirements:

* `totalAmount > 0`.
* `discountBps <= 10000 (100%`.
* If `pricingType` is `FIXED`, `fixedPricePerToken > 0`.
* `paymentAsset` must be in `allowedPaymentAssets`.


Behavior:

* Transfers `totalAmount` of `token` from the seller to the contract.
* Creates a listing and assigns it an ID.
* Emits `ListingCreated`.


Returns: The listing ID.
Usage: Seller must approve the contract to transfer `totalAmount` of `token`
before calling.

### 4. `initiateTrade(uint256 listingId, uint256 tokenAmount)`

Description: Allows a buyer to purchase tokens from a listing.
Parameters:

* `listingId`: ID of the listing.
* `tokenAmount`: Amount of tokens to buy.


Requirements:

* Listing status must be `OPEN`.
* `0 < tokenAmount <= remainingAmount`.
* Current block must be within `MAX_BLOCKS` of listing creation.


Behavior:

* Calculates payment amount using `_calcPrice`.
* Transfers payment from buyer to contract.
* Updates listing's `remainingAmount`.
* Sets listing status to `FUNDED` if `remainingAmount` reaches zero.
* Creates a trade and assigns it an ID.
* Emits `TradeInitiated`.


Returns: The trade ID.
Usage: Buyer must approve the contract to transfer the payment amount.

### 5. `sellerRelease(uint256 tradeId)`

Description: Allows the seller to release tokens to the buyer and receive payment.
Parameters:

* `tradeId`: ID of the trade.


Requirements:

* Caller must be the seller.
* Trade must have `buyerConfirmed` as `true` and `sellerConfirmed` as `false`.


Behavior:

* Transfers tokens to the buyer.
* Transfers payment to the seller.
* Sets listing status to `COMPLETED`.
* Emits `SellerReleased`.


Usage: Called by the seller to finalize a trade.

### 6. `raiseDispute(uint256 tradeId)`

Description: Allows the buyer or seller to dispute a trade.
Parameters:

* `tradeId`: ID of the trade.


Requirements:

* Caller must be the buyer or seller.
* Current block must exceed trade creation block by `MAX_BLOCKS`.
* Trade must not already be disputed.


Behavior:

* Marks trade as disputed.
* Sets listing status to `DISPUTED`.
* Emits `TradeDisputed`.


Usage: Use if a trade isn't completed within the time limit.

### 7. `confirmDisputeResolution(uint256 tradeId)`

Description: Allows the owner to confirm a dispute resolution.
Parameters:

* `tradeId`: ID of the trade.


Behavior:

* Sets `disputeConfirmations[tradeId]` to `true`.


Access: Only the contract owner.
Usage: Precedes `resolveDispute` to authorize resolution.

### 8. `resolveDispute(uint256 tradeId, bool refundBuyer)`

Description: Resolves a disputed trade.
Parameters:

* `tradeId`: ID of the trade.
* `refundBuyer`: `true` to refund the buyer, `false` to complete the trade.


Requirements:

* Dispute must be confirmed by the owner.
* Trade must be disputed.


Behavior:

* If `refundBuyer` is `true`:
  * Refunds payment to the buyer.
  * Returns tokens to the seller.
* If `refundBuyer` is `false`:
  * Transfers tokens to the buyer.
  * Transfers payment to the seller.
* Sets listing status to `CANCELLED`.
* Emits `TradeResolved`.


Usage: Called by anyone after owner confirmation to finalize a dispute.

## Internal Functions

### `_calcPrice(Listing memory listing, uint256 qty)`

Description: Calculates payment amount based on pricing type.
For `FIXED`: `fixedPricePerToken * qty`.
For `DYNAMIC`: Applies discount to Uniswap V3 price from `_getDynamicPrice`.

### `_getDynamicPrice(Listing memory listing, uint256 qty)`

Description: Fetches price from Uniswap V3 pool using `sqrtPriceX96`.

### `_countDisputeConfirmations(uint256 tradeId)`

Description: Returns 1 if dispute is confirmed, 0 otherwise.

## Usage Notes

### Approvals

Sellers and buyers must approve the contract to transfer their respective tokens
(tokenOffered and paymentAsset) before interacting.

### Dynamic Pricing

Requires a valid Uniswap V3 pool address with sufficient liquidity for the token
pair.

### Disputes

Resolution is centralized, relying on the owner's decision.

### Time Limits

Trades must be completed or disputed within `MAX_BLOCKS` (~30 minutes).

