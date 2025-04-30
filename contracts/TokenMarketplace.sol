// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

contract TokenMarketplace {
    enum TradeState { Pending, Completed, Disputed, Resolved }

    struct Listing {
        address seller;
        address token;
        uint128 amount; // Total tokens listed
        uint128 pricePerToken; // Price per token in payment asset (fixed pricing)
        uint32 releaseTime; // Timestamp for trade release
        address paymentAsset; // ERC-20 token or address(0) for ETH
        uint16 discountBps; // Discount in basis points for dynamic pricing
        bool isDynamic; // True for dynamic pricing
        bool active;
    }

    struct Trade {
        uint128 amount; // Tokens to buy
        uint128 totalPrice; // Total payment amount
        address buyer;
        uint32 listingId; // Reference to listing
        TradeState state;
        bool sellerConfirmed;
        bool buyerConfirmed;
    }

    mapping(uint32 => Listing) public listings;
    mapping(uint32 => Trade) public trades;
    mapping(address => bool) public supportedPaymentAssets;
    uint32 public nextListingId;
    uint32 public nextTradeId;
    AggregatorV3Interface public priceFeed;
    address immutable public admin;
    uint32 public constant MAX_RELEASE_TIME = 30 minutes;
    uint16 public constant BPS_DENOMINATOR = 10000;

    event Listed(
        uint32 indexed listingId,
        address indexed seller,
        address token,
        uint128 amount,
        uint128 pricePerToken,
        bool isDynamic,
        uint16 discountBps,
        uint32 releaseTime,
        address paymentAsset
    );
    event TradeInitiated(uint32 indexed tradeId, uint32 indexed listingId, address indexed buyer, uint128 amount, uint128 totalPrice);
    event TradeConfirmed(uint32 indexed tradeId, address indexed confirmer, bool isBuyer);
    event TradeCompleted(uint32 indexed tradeId);
    event TradeDisputed(uint32 indexed tradeId, address indexed disputer);
    event TradeResolved(uint32 indexed tradeId, address indexed recipient, uint128 tokenAmount, uint128 paymentAmount);
    event Cancelled(uint32 indexed listingId);
    event PriceFeedUpdated(address indexed token, address priceFeed);
    event PaymentAssetAdded(address indexed asset);
    event PaymentAssetRemoved(address indexed asset);

    constructor() {
        admin = msg.sender;
        supportedPaymentAssets[address(0)] = true; // Enable ETH
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    modifier onlyTradeParty(uint32 tradeId) {
        Trade memory trade = trades[tradeId];
        require(msg.sender == trade.buyer || msg.sender == listings[trade.listingId].seller, "Only trade parties");
        _;
    }

    // Admin functions
    function addPaymentAsset(address asset) external onlyAdmin {
        require(asset != address(0) && !supportedPaymentAssets[asset], "Invalid or supported asset");
        supportedPaymentAssets[asset] = true;
        emit PaymentAssetAdded(asset);
    }

    function removePaymentAsset(address asset) external onlyAdmin {
        require(supportedPaymentAssets[asset] && asset != address(0), "Invalid or ETH asset");
        supportedPaymentAssets[asset] = false;
        emit PaymentAssetRemoved(asset);
    }

    function setPriceFeed(address token, address _priceFeed) external onlyAdmin {
        priceFeed = AggregatorV3Interface(_priceFeed);
        emit PriceFeedUpdated(token, _priceFeed);
    }

    // List tokens
    function listTokens(
        address token,
        uint128 amount,
        uint128 pricePerToken,
        bool isDynamic,
        uint16 discountBps,
        uint32 releaseTime,
        address paymentAsset
    ) external {
        require(amount > 0, "Amount must be > 0");
        require(releaseTime > block.timestamp && releaseTime <= block.timestamp + MAX_RELEASE_TIME, "Invalid release time");
        require(supportedPaymentAssets[paymentAsset], "Unsupported payment asset");
        if (isDynamic) {
            require(discountBps <= BPS_DENOMINATOR && address(priceFeed) != address(0), "Invalid dynamic params");
        } else {
            require(pricePerToken > 0, "Price per token must be > 0");
        }

        IERC20(token).transferFrom(msg.sender, address(this), amount);

        uint32 listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            token: token,
            amount: amount,
            pricePerToken: isDynamic ? 0 : pricePerToken,
            isDynamic: isDynamic,
            discountBps: isDynamic ? discountBps : 0,
            releaseTime: releaseTime,
            paymentAsset: paymentAsset,
            active: true
        });

        emit Listed(listingId, msg.sender, token, amount, pricePerToken, isDynamic, discountBps, releaseTime, paymentAsset);
    }

    // Get dynamic price per token in ETH
    function getDynamicPricePerToken(uint32 listingId) public view returns (uint128) {
        Listing memory listing = listings[listingId];
        require(listing.isDynamic, "Not dynamic");

        (, int256 price, , , ) = priceFeed.latestRoundData();
        require(price > 0, "Invalid price feed");

        uint128 marketPrice = uint128(uint256(price));
        return (marketPrice * (BPS_DENOMINATOR - listing.discountBps)) / BPS_DENOMINATOR;
    }

    // Initiate a trade
    function initiateTrade(uint32 listingId, uint128 amountToBuy) external payable {
        Listing memory listing = listings[listingId];
        require(listing.active && block.timestamp <= listing.releaseTime, "Listing inactive or expired");
        require(amountToBuy > 0 && amountToBuy <= listing.amount, "Invalid amount");

        uint128 pricePerToken = listing.isDynamic ? getDynamicPricePerToken(listingId) : listing.pricePerToken;
        uint128 totalPrice = uint128((uint256(pricePerToken) * amountToBuy) / 1e18);
        require(totalPrice > 0, "Total price must be > 0");

        // Lock payment
        if (listing.paymentAsset == address(0)) {
            require(msg.value == totalPrice, "Incorrect ETH value");
        } else {
            require(msg.value == 0, "ETH not accepted");
            IERC20(listing.paymentAsset).transferFrom(msg.sender, address(this), totalPrice);
        }

        // Update listing
        listings[listingId].amount -= amountToBuy;
        if (listings[listingId].amount == 0) {
            listings[listingId].active = false;
        }

        // Create trade
        uint32 tradeId = nextTradeId++;
        trades[tradeId] = Trade({
            amount: amountToBuy,
            totalPrice: totalPrice,
            buyer: msg.sender,
            listingId: listingId,
            state: TradeState.Pending,
            sellerConfirmed: false,
            buyerConfirmed: false
        });

        emit TradeInitiated(tradeId, listingId, msg.sender, amountToBuy, totalPrice);
    }

    // Confirm trade
    function confirmTrade(uint32 tradeId) external onlyTradeParty(tradeId) {
        Trade storage trade = trades[tradeId];
        Listing memory listing = listings[trade.listingId];
        require(trade.state == TradeState.Pending && block.timestamp <= listing.releaseTime, "Trade not pending or expired");

        if (msg.sender == trade.buyer) {
            trade.buyerConfirmed = true;
        } else {
            trade.sellerConfirmed = true;
        }

        emit TradeConfirmed(tradeId, msg.sender, msg.sender == trade.buyer);

        if (trade.buyerConfirmed && trade.sellerConfirmed) {
            trade.state = TradeState.Completed;

            // Release assets
            IERC20(listing.token).transfer(trade.buyer, trade.amount);
            if (listing.paymentAsset == address(0)) {
                payable(listing.seller).transfer(trade.totalPrice);
            } else {
                IERC20(listing.paymentAsset).transfer(listing.seller, trade.totalPrice);
            }

            emit TradeCompleted(tradeId);
        }
    }

    // Raise dispute
    function disputeTrade(uint32 tradeId) external onlyTradeParty(tradeId) {
        Trade storage trade = trades[tradeId];
        require(trade.state == TradeState.Pending && block.timestamp > listings[trade.listingId].releaseTime, "Cannot dispute");

        trade.state = TradeState.Disputed;
        emit TradeDisputed(tradeId, msg.sender);
    }

    // Resolve dispute
    function resolveDispute(
        uint32 tradeId,
        bool refundBuyer,
        uint128 tokenAmountToBuyer,
        uint128 paymentAmountToSeller
    ) external onlyAdmin {
        Trade storage trade = trades[tradeId];
        require(trade.state == TradeState.Disputed, "Not disputed");
        require(tokenAmountToBuyer <= trade.amount && paymentAmountToSeller <= trade.totalPrice, "Invalid amounts");

        Listing memory listing = listings[trade.listingId];
        trade.state = TradeState.Resolved;

        // Distribute tokens
        IERC20 tokenContract = IERC20(listing.token);
        if (tokenAmountToBuyer > 0) {
            tokenContract.transfer(trade.buyer, tokenAmountToBuyer);
        }
        if (trade.amount > tokenAmountToBuyer) {
            tokenContract.transfer(listing.seller, trade.amount - tokenAmountToBuyer);
        }

        // Distribute payment
        if (listing.paymentAsset == address(0)) {
            if (paymentAmountToSeller > 0) {
                payable(listing.seller).transfer(paymentAmountToSeller);
            }
            if (trade.totalPrice > paymentAmountToSeller) {
                payable(trade.buyer).transfer(trade.totalPrice - paymentAmountToSeller);
            }
        } else {
            IERC20 paymentContract = IERC20(listing.paymentAsset);
            if (paymentAmountToSeller > 0) {
                paymentContract.transfer(listing.seller, paymentAmountToSeller);
            }
            if (trade.totalPrice > paymentAmountToSeller) {
                paymentContract.transfer(trade.buyer, trade.totalPrice - paymentAmountToSeller);
            }
        }

        emit TradeResolved(tradeId, refundBuyer ? trade.buyer : listing.seller, tokenAmountToBuyer, paymentAmountToSeller);
    }

    // Cancel listing
    function cancelListing(uint32 listingId) external {
        Listing storage listing = listings[listingId];
        require(listing.seller == msg.sender && listing.active, "Invalid or inactive listing");

        IERC20(listing.token).transfer(msg.sender, listing.amount);
        listing.active = false;
        emit Cancelled(listingId);
    }
}