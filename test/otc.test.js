const { expect } = require("chai");
const { ethers } = require("hardhat"); // Correct import for ethers
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TokenMarketplace", function () {
  let TokenMarketplace, tokenMarketplace, MockToken, mockToken, MockPriceFeed, mockPriceFeed;
  let owner, seller, buyer, other;
  const TOKEN_AMOUNT = ethers.utils.parseUnits("1000", 18); // Using ethers.utils.parseUnits
  const PRICE_PER_TOKEN = ethers.utils.parseUnits("1", 18); // 1 ETH or ERC-20 per token
  const DISCOUNT_BPS = 500; // 5% discount
  const RELEASE_TIME_OFFSET = 15 * 60; // 15 minutes

  beforeEach(async function () {
    [owner, seller, buyer, other] = await ethers.getSigners();

    // Deploy Mock ERC-20 Token
    MockToken = await ethers.getContractFactory("MockERC20");
    mockToken = await MockToken.deploy("Mock Token", "MTK", ethers.utils.parseUnits("2000", 18));
    await mockToken.deployed();

    // Deploy Mock Chainlink Price Feed
    MockPriceFeed = await ethers.getContractFactory("MockV3Aggregator");
    mockPriceFeed = await MockPriceFeed.deploy(18, ethers.utils.parseUnits("0.01", 18)); // 0.01 ETH per token
    await mockPriceFeed.deployed();

    // Deploy TokenMarketplace
    TokenMarketplace = await ethers.getContractFactory("TokenMarketplace");
    tokenMarketplace = await TokenMarketplace.deploy();
    await tokenMarketplace.deployed();

    // Setup
    await tokenMarketplace.connect(owner).setPriceFeed(mockToken.address, mockPriceFeed.address);
    await tokenMarketplace.connect(owner).addPaymentAsset(mockToken.address); // MockToken as payment asset
    await mockToken.connect(owner).transfer(seller.address, TOKEN_AMOUNT);
    await mockToken.connect(owner).transfer(buyer.address, TOKEN_AMOUNT);
    await mockToken.connect(seller).approve(tokenMarketplace.address, TOKEN_AMOUNT);
    await mockToken.connect(buyer).approve(tokenMarketplace.address, TOKEN_AMOUNT);
  });

  describe("Listing Tokens", function () {
    it("should allow seller to list tokens with fixed pricing", async function () {
      const releaseTime = (await time.latest()) + RELEASE_TIME_OFFSET;
      await expect(
        tokenMarketplace
          .connect(seller)
          .listTokens(mockToken.address, TOKEN_AMOUNT, PRICE_PER_TOKEN, false, 0, releaseTime, ethers.constants.AddressZero)
      )
        .to.emit(tokenMarketplace, "Listed")
        .withArgs(0, seller.address, mockToken.address, TOKEN_AMOUNT, PRICE_PER_TOKEN, false, 0, releaseTime, ethers.constants.AddressZero);
      const listing = await tokenMarketplace.listings(0);
      expect(listing.seller).to.equal(seller.address);
      expect(listing.amount).to.equal(TOKEN_AMOUNT);
      expect(listing.active).to.be.true;
    });

    it("should revert if amount is zero", async function () {
      const releaseTime = (await time.latest()) + RELEASE_TIME_OFFSET;
      await expect(
        tokenMarketplace
          .connect(seller)
          .listTokens(mockToken.address, 0, PRICE_PER_TOKEN, false, 0, releaseTime, ethers.constants.AddressZero)
      ).to.be.revertedWith("Amount must be > 0");
    });
  });

  describe("Initiating Trades", function () {
    let listingId, releaseTime;

    beforeEach(async function () {
      releaseTime = (await time.latest()) + RELEASE_TIME_OFFSET;
      await tokenMarketplace
        .connect(seller)
        .listTokens(mockToken.address, TOKEN_AMOUNT, PRICE_PER_TOKEN, false, 0, releaseTime, mockToken.address);
      listingId = 0;
    });

    it("should allow buyer to initiate trade with ERC-20 payment", async function () {
      const amountToBuy = TOKEN_AMOUNT.div(2);
      const totalPrice = amountToBuy.mul(PRICE_PER_TOKEN).div(ethers.utils.parseUnits("1", 18));
      await expect(tokenMarketplace.connect(buyer).initiateTrade(listingId, amountToBuy))
        .to.emit(tokenMarketplace, "TradeInitiated")
        .withArgs(0, listingId, buyer.address, amountToBuy, totalPrice);
      const trade = await tokenMarketplace.trades(0);
      expect(trade.buyer).to.equal(buyer.address);
      expect(trade.amount).to.equal(amountToBuy);
      expect(trade.state).to.equal(0); // Pending
    });

    it("should revert if amount exceeds listing amount", async function () {
      await expect(
        tokenMarketplace.connect(buyer).initiateTrade(listingId, TOKEN_AMOUNT.add(1))
      ).to.be.revertedWith("Invalid amount");
    });
  });

  describe("Confirming Trades", function () {
    let listingId, tradeId, releaseTime, amountToBuy, totalPrice;

    beforeEach(async function () {
      releaseTime = (await time.latest()) + RELEASE_TIME_OFFSET;
      await tokenMarketplace
        .connect(seller)
        .listTokens(mockToken.address, TOKEN_AMOUNT, PRICE_PER_TOKEN, false, 0, releaseTime, mockToken.address);
      listingId = 0;
      amountToBuy = TOKEN_AMOUNT.div(2);
      totalPrice = amountToBuy.mul(PRICE_PER_TOKEN).div(ethers.utils.parseUnits("1", 18));
      await tokenMarketplace.connect(buyer).initiateTrade(listingId, amountToBuy);
      tradeId = 0;
    });

    it("should allow buyer and seller to confirm trade", async function () {
      await expect(tokenMarketplace.connect(buyer).confirmTrade(tradeId))
        .to.emit(tokenMarketplace, "TradeConfirmed")
        .withArgs(tradeId, buyer.address, true);
      await expect(tokenMarketplace.connect(seller).confirmTrade(tradeId))
        .to.emit(tokenMarketplace, "TradeConfirmed")
        .withArgs(tradeId, seller.address, false)
        .to.emit(tokenMarketplace, "TradeCompleted")
        .withArgs(tradeId);
      const trade = await tokenMarketplace.trades(tradeId);
      expect(trade.state).to.equal(1); // Completed
    });

    it("should revert if non-party tries to confirm", async function () {
      await expect(tokenMarketplace.connect(other).confirmTrade(tradeId)).to.be.revertedWith("Only trade parties");
    });
  });

  describe("Canceling Listings", function () {
    let listingId, releaseTime;

    beforeEach(async function () {
      releaseTime = (await time.latest()) + RELEASE_TIME_OFFSET;
      await tokenMarketplace
        .connect(seller)
        .listTokens(mockToken.address, TOKEN_AMOUNT, PRICE_PER_TOKEN, false, 0, releaseTime, mockToken.address);
      listingId = 0;
    });

    it("should allow seller to cancel listing", async function () {
      await expect(tokenMarketplace.connect(seller).cancelListing(listingId))
        .to.emit(tokenMarketplace, "Cancelled")
        .withArgs(listingId);
      const listing = await tokenMarketplace.listings(listingId);
      expect(listing.active).to.be.false;
    });

    it("should revert if non-seller tries to cancel", async function () {
      await expect(tokenMarketplace.connect(buyer).cancelListing(listingId)).to.be.revertedWith("Invalid or inactive listing");
    });
  });

  describe("Disputing Trades", function () {
    let listingId, tradeId, releaseTime, amountToBuy;

    beforeEach(async function () {
      releaseTime = (await time.latest()) + RELEASE_TIME_OFFSET;
      await tokenMarketplace
        .connect(seller)
        .listTokens(mockToken.address, TOKEN_AMOUNT, PRICE_PER_TOKEN, false, 0, releaseTime, mockToken.address);
      listingId = 0;
      amountToBuy = TOKEN_AMOUNT.div(2);
      await tokenMarketplace.connect(buyer).initiateTrade(listingId, amountToBuy);
      tradeId = 0;
      await time.increaseTo(releaseTime + 1); // Move past release time
    });

    it("should allow buyer to dispute trade after release time", async function () {
      await expect(tokenMarketplace.connect(buyer).disputeTrade(tradeId))
        .to.emit(tokenMarketplace, "TradeDisputed")
        .withArgs(tradeId, buyer.address);
      const trade = await tokenMarketplace.trades(tradeId);
      expect(trade.state).to.equal(2); // Disputed
    });

    it("should revert if trade is not pending", async function () {
      await tokenMarketplace.connect(buyer).disputeTrade(tradeId);
      await expect(tokenMarketplace.connect(buyer).disputeTrade(tradeId)).to.be.revertedWith("Cannot dispute");
    });
  });
});