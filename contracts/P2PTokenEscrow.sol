// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapV3Pool {
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );
}

contract P2PTokenEscrow is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    
    enum PricingType { FIXED, DYNAMIC }
    enum TradeStatus { OPEN, FUNDED, COMPLETED, CANCELLED, DISPUTED }

    struct Listing {
        address seller;
        IERC20 tokenOffered;
        uint256 totalAmount;
        uint256 remainingAmount;
        PricingType pricingType;
        uint256 fixedPricePerToken;
        uint256 discountBps;
        IERC20 paymentAsset;
        uint256 createdAtBlock;
        TradeStatus status;
        address priceFeed; // Uniswap V3 pool address for dynamic pricing
    }

    struct Trade {
        uint256 listingId;
        address buyer;
        uint256 tokenAmount;
        uint256 paymentAmount;
        uint256 createdAtBlock;
        bool buyerConfirmed;
        bool sellerConfirmed;
        bool disputed;
    }

    uint256 public constant MAX_BLOCKS = 120; // 30 minutes at 15s/block
    uint256 public listingCounter;
    uint256 public tradeCounter;

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Trade) public trades;
    mapping(address => bool) public allowedPaymentAssets;
    mapping(uint256 => bool) public disputeConfirmations; // Simplified for single admin
    uint256 public constant REQUIRED_CONFIRMATIONS = 1; // Single admin confirmation

    event ListingCreated(uint256 indexed id, address indexed seller);
    event TradeInitiated(uint256 indexed tradeId, uint256 indexed listingId, address indexed buyer);
    event SellerReleased(uint256 indexed tradeId);
    event TradeDisputed(uint256 indexed tradeId);
    event TradeResolved(uint256 indexed tradeId, bool inFavorOfBuyer);

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyAllowedAsset(IERC20 asset) {
        require(allowedPaymentAssets[address(asset)], "Payment asset not allowed");
        _;
    }

    function setPaymentAsset(address asset, bool allowed) external onlyOwner {
        allowedPaymentAssets[asset] = allowed;
    }

    function revokePaymentAsset(address asset) external onlyOwner {
        allowedPaymentAssets[asset] = false;
    }

    function createListing(
        IERC20 token,
        uint256 totalAmount,
        PricingType pricingType,
        uint256 fixedPricePerToken,
        uint256 discountBps,
        IERC20 paymentAsset,
        address priceFeed // Uniswap V3 pool address
    ) external nonReentrant onlyAllowedAsset(paymentAsset) returns (uint256 listingId) {
        require(totalAmount > 0, "Total amount must be > 0");
        require(discountBps <= 10000, "Discount must be <= 100%");
        require(
            pricingType == PricingType.DYNAMIC || fixedPricePerToken > 0,
            "Fixed price required"
        );

        listingId = ++listingCounter;
        listings[listingId] = Listing({
            seller: msg.sender,
            tokenOffered: token,
            totalAmount: totalAmount,
            remainingAmount: totalAmount,
            pricingType: pricingType,
            fixedPricePerToken: fixedPricePerToken,
            discountBps: discountBps,
            paymentAsset: paymentAsset,
            createdAtBlock: block.number,
            status: TradeStatus.OPEN,
            priceFeed: priceFeed
        });

        token.safeTransferFrom(msg.sender, address(this), totalAmount);
        emit ListingCreated(listingId, msg.sender);
    }

    function initiateTrade(uint256 listingId, uint256 tokenAmount)
        external nonReentrant returns (uint256 tradeId)
    {
        Listing storage L = listings[listingId];
        require(L.status == TradeStatus.OPEN, "Listing not open");
        require(tokenAmount > 0 && tokenAmount <= L.remainingAmount, "Invalid amount");
        require(block.number <= L.createdAtBlock + MAX_BLOCKS, "Listing expired");

        uint256 payAmt = _calcPrice(L, tokenAmount);

        L.paymentAsset.safeTransferFrom(msg.sender, address(this), payAmt);
        L.remainingAmount -= tokenAmount;
        
        if (L.remainingAmount == 0) {
            L.status = TradeStatus.FUNDED;
        }

        tradeId = ++tradeCounter;
        trades[tradeId] = Trade({
            listingId: listingId,
            buyer: msg.sender,
            tokenAmount: tokenAmount,
            paymentAmount: payAmt,
            createdAtBlock: block.number,
            buyerConfirmed: true,
            sellerConfirmed: false,
            disputed: false
        });

        emit TradeInitiated(tradeId, listingId, msg.sender);
    }

    function sellerRelease(uint256 tradeId) external nonReentrant {
        Trade storage T = trades[tradeId];
        Listing storage L = listings[T.listingId];

        require(msg.sender == L.seller, "Only seller");
        require(T.buyerConfirmed && !T.sellerConfirmed, "Invalid state");

        T.sellerConfirmed = true;
        L.tokenOffered.safeTransfer(T.buyer, T.tokenAmount);
        L.paymentAsset.safeTransfer(L.seller, T.paymentAmount);
        L.status = TradeStatus.COMPLETED;

        emit SellerReleased(tradeId);
    }

    function raiseDispute(uint256 tradeId) external {
        Trade storage T = trades[tradeId];
        Listing storage L = listings[T.listingId];

        require(
            msg.sender == T.buyer || msg.sender == L.seller,
            "Unauthorized"
        );
        require(block.number > T.createdAtBlock + MAX_BLOCKS, "Too early");
        require(!T.disputed, "Already disputed");

        T.disputed = true;
        L.status = TradeStatus.DISPUTED;
        emit TradeDisputed(tradeId);
    }

    function confirmDisputeResolution(uint256 tradeId) external onlyOwner {
        disputeConfirmations[tradeId] = true;
    }

    function resolveDispute(uint256 tradeId, bool refundBuyer) external nonReentrant {
        require(disputeConfirmations[tradeId], "Not confirmed");
        require(
            _countDisputeConfirmations(tradeId) >= REQUIRED_CONFIRMATIONS,
            "Insufficient confirmations"
        );

        Trade storage T = trades[tradeId];
        Listing storage L = listings[T.listingId];
        require(T.disputed, "No dispute");

        T.disputed = false;
        L.status = TradeStatus.CANCELLED;

        if (refundBuyer) {
            L.paymentAsset.safeTransfer(T.buyer, T.paymentAmount);
            L.tokenOffered.safeTransfer(L.seller, T.tokenAmount);
        } else {
            L.tokenOffered.safeTransfer(T.buyer, T.tokenAmount);
            L.paymentAsset.safeTransfer(L.seller, T.paymentAmount);
        }
        
        emit TradeResolved(tradeId, refundBuyer);
    }

    function _calcPrice(Listing memory listing, uint256 qty)
        internal view returns (uint256)
    {
        if (listing.pricingType == PricingType.FIXED) {
            return listing.fixedPricePerToken * qty;
        } else {
            uint256 marketValue = _getDynamicPrice(listing, qty);
            uint256 discount = (marketValue * listing.discountBps) / 10000;
            uint256 discounted = marketValue - discount;
            require(discounted > 0, "Overdiscounted");
            return discounted;
        }
    }

    function _getDynamicPrice(Listing memory listing, uint256 qty)
        internal view returns (uint256)
    {
        IUniswapV3Pool pool = IUniswapV3Pool(listing.priceFeed);
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        
        require(sqrtPriceX96 > 0, "Invalid price");
        
        // Calculate price: (sqrtPriceX96^2 * qty) / 2^192
        // Assuming tokenOffered is token0 and paymentAsset is token1 (adjust if reversed)
        uint256 price = (uint256(sqrtPriceX96) * uint256(sqrtPriceX96) * qty) >> 192;
        return price;
    }

    function _countDisputeConfirmations(uint256 tradeId)
        internal view returns (uint256 count)
    {
        if (disputeConfirmations[tradeId]) {
            count = 1;
        }
    }
}