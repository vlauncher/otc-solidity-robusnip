const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("P2PTokenEscrow", function () {
  let owner, seller, buyer, admin;
  let tokenOffered, paymentAsset;
  let mockPool;
  let p2pEscrow;

  beforeEach(async function () {

    // Initialize signers
    const signers = await ethers.getSigners();
    if (signers.length < 4) {
      throw new Error("Insufficient signers available. Expected at least 4.");
    }
    [owner, seller, buyer, admin] = signers;
    console.log("Owner address:", owner.address); // Debug: Verify owner address

    // Deploy mock ERC20 tokens
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    tokenOffered = await ERC20Mock.deploy("Token Offered", "TO", ethers.parseEther("1000"));
    paymentAsset = await ERC20Mock.deploy("Payment Asset", "PA", ethers.parseEther("1000"));
    console.log("TokenOffered address:", tokenOffered.address); // Debug: Verify deployment
    console.log("PaymentAsset address:", paymentAsset.address); // Debug: Verify deployment

    // Deploy mock Uniswap V3 pool
    const MockUniswapV3Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    mockPool = await MockUniswapV3Pool.deploy();
    console.log("MockPool address:", mockPool.address); // Debug: Verify deployment

    // Deploy P2PTokenEscrow contract
    const P2PTokenEscrow = await ethers.getContractFactory("P2PTokenEscrow");
    p2pEscrow = await P2PTokenEscrow.deploy(owner.address);
    console.log("P2PTokenEscrow address:", p2pEscrow.address); // Debug: Verify deployment

    // Set allowed payment asset
    await p2pEscrow.connect(owner).setPaymentAsset(paymentAsset.address, true);

    // Transfer tokens to seller and buyer
    await tokenOffered.transfer(seller.address, ethers.parseEther("100"));
    await paymentAsset.transfer(buyer.address, ethers.parseEther("100"));
  });

  describe("Listing Creation", function () {
    it("should create a listing with fixed pricing", async function () {
      const totalAmount = ethers.parseEther("10");
      const fixedPricePerToken = 1; // 1 wei per wei
      const discountBps = 0;
      const pricingType = 0; // FIXED

      await tokenOffered.connect(seller).approve(p2pEscrow.address, totalAmount);
      await expect(p2pEscrow.connect(seller).createListing(
        tokenOffered.address,
        totalAmount,
        pricingType,
        fixedPricePerToken,
        discountBps,
        paymentAsset.address,
        mockPool.address
      )).to.emit(p2pEscrow, "ListingCreated").withArgs(1, seller.address);

      const listing = await p2pEscrow.listings(1);
      expect(listing.totalAmount).to.equal(totalAmount);
      expect(listing.remainingAmount).to.equal(totalAmount);
      expect(listing.pricingType).to.equal(pricingType);
      expect(listing.fixedPricePerToken).to.equal(fixedPricePerToken);
      expect(await tokenOffered.balanceOf(p2pEscrow.address)).to.equal(totalAmount);
    });

    it("should create a listing with dynamic pricing", async function () {
      const totalAmount = ethers.parseEther("10");
      const discountBps = 1000; // 10% discount
      const pricingType = 1; // DYNAMIC

      await tokenOffered.connect(seller).approve(p2pEscrow.address, totalAmount);
      await expect(p2pEscrow.connect(seller).createListing(
        tokenOffered.address,
        totalAmount,
        pricingType,
        0,
        discountBps,
        paymentAsset.address,
        mockPool.address
      )).to.emit(p2pEscrow, "ListingCreated").withArgs(1, seller.address);

      const listing = await p2pEscrow.listings(1);
      expect(listing.pricingType).to.equal(pricingType);
      expect(listing.discountBps).to.equal(discountBps);
      expect(listing.priceFeed).to.equal(mockPool.address);
    });

    it("should not allow listing with zero amount", async function () {
      await expect(p2pEscrow.connect(seller).createListing(
        tokenOffered.address,
        0,
        0,
        1,
        0,
        paymentAsset.address,
        mockPool.address
      )).to.be.revertedWith("Total amount must be > 0");
    });
  });

  describe("Trade Initiation", function () {
    it("should initiate a trade with fixed pricing", async function () {
      const totalAmount = ethers.parseEther("10");
      const fixedPricePerToken = 1;
      const tokenAmount = ethers.parseEther("2");
      const expectedPayment = tokenAmount.mul(fixedPricePerToken);

      await tokenOffered.connect(seller).approve(p2pEscrow.address, totalAmount);
      await p2pEscrow.connect(seller).createListing(
        tokenOffered.address,
        totalAmount,
        0,
        fixedPricePerToken,
        0,
        paymentAsset.address,
        mockPool.address
      );

      await paymentAsset.connect(buyer).approve(p2pEscrow.address, expectedPayment);
      await expect(p2pEscrow.connect(buyer).initiateTrade(1, tokenAmount))
        .to.emit(p2pEscrow, "TradeInitiated").withArgs(1, 1, buyer.address);

      const trade = await p2pEscrow.trades(1);
      expect(trade.paymentAmount).to.equal(expectedPayment);
      expect(await paymentAsset.balanceOf(p2pEscrow.address)).to.equal(expectedPayment);
    });

    it("should initiate a trade with dynamic pricing", async function () {
      const totalAmount = ethers.parseEther("10");
      const tokenAmount = ethers.parseEther("2");
      const discountBps = 1000;
      const sqrtPriceX96 = ethers.BigNumber.from(2).pow(96); // Price = 1
      await mockPool.setSqrtPriceX96(sqrtPriceX96);

      const marketValue = (sqrtPriceX96.pow(2).mul(tokenAmount)).shr(192);
      const discount = marketValue.mul(discountBps).div(10000);
      const expectedPayment = marketValue.sub(discount);

      await tokenOffered.connect(seller).approve(p2pEscrow.address, totalAmount);
      await p2pEscrow.connect(seller).createListing(
        tokenOffered.address,
        totalAmount,
        1,
        0,
        discountBps,
        paymentAsset.address,
        mockPool.address
      );

      await paymentAsset.connect(buyer).approve(p2pEscrow.address, expectedPayment);
      await expect(p2pEscrow.connect(buyer).initiateTrade(1, tokenAmount))
        .to.emit(p2pEscrow, "TradeInitiated").withArgs(1, 1, buyer.address);

      const trade = await p2pEscrow.trades(1);
      expect(trade.paymentAmount).to.equal(expectedPayment);
    });
  });

  describe("Seller Release", function () {
    it("should allow seller to release the trade", async function () {
      const totalAmount = ethers.parseEther("10");
      const fixedPricePerToken = 1;
      const tokenAmount = ethers.parseEther("2");
      const paymentAmount = tokenAmount.mul(fixedPricePerToken);

      await tokenOffered.connect(seller).approve(p2pEscrow.address, totalAmount);
      await p2pEscrow.connect(seller).createListing(
        tokenOffered.address,
        totalAmount,
        0,
        fixedPricePerToken,
        0,
        paymentAsset.address,
        mockPool.address
      );

      await paymentAsset.connect(buyer).approve(p2pEscrow.address, paymentAmount);
      await p2pEscrow.connect(buyer).initiateTrade(1, tokenAmount);

      await expect(p2pEscrow.connect(seller).sellerRelease(1))
        .to.emit(p2pEscrow, "SellerReleased").withArgs(1);

      expect(await tokenOffered.balanceOf(buyer.address)).to.equal(tokenAmount);
      expect(await paymentAsset.balanceOf(seller.address)).to.equal(paymentAmount);
      const listing = await p2pEscrow.listings(1);
      expect(listing.status).to.equal(2); // COMPLETED
    });
  });

  describe("Dispute Handling", function () {
    it("should allow dispute after time limit", async function () {
      const totalAmount = ethers.parseEther("10");
      const fixedPricePerToken = 1;
      const tokenAmount = ethers.parseEther("2");
      const paymentAmount = tokenAmount.mul(fixedPricePerToken);

      await tokenOffered.connect(seller).approve(p2pEscrow.address, totalAmount);
      await p2pEscrow.connect(seller).createListing(
        tokenOffered.address,
        totalAmount,
        0,
        fixedPricePerToken,
        0,
        paymentAsset.address,
        mockPool.address
      );

      await paymentAsset.connect(buyer).approve(p2pEscrow.address, paymentAmount);
      await p2pEscrow.connect(buyer).initiateTrade(1, tokenAmount);

      for (let i = 0; i < 121; i++) {
        await ethers.provider.send("evm_mine", []);
      }

      await expect(p2pEscrow.connect(buyer).raiseDispute(1))
        .to.emit(p2pEscrow, "TradeDisputed").withArgs(1);

      const trade = await p2pEscrow.trades(1);
      expect(trade.disputed).to.be.true;
    });

    it("should allow admin to resolve dispute in favor of buyer", async function () {
      const totalAmount = ethers.parseEther("10");
      const fixedPricePerToken = 1;
      const tokenAmount = ethers.parseEther("2");
      const paymentAmount = tokenAmount.mul(fixedPricePerToken);

      await tokenOffered.connect(seller).approve(p2pEscrow.address, totalAmount);
      await p2pEscrow.connect(seller).createListing(
        tokenOffered.address,
        totalAmount,
        0,
        fixedPricePerToken,
        0,
        paymentAsset.address,
        mockPool.address
      );

      await paymentAsset.connect(buyer).approve(p2pEscrow.address, paymentAmount);
      await p2pEscrow.connect(buyer).initiateTrade(1, tokenAmount);

      for (let i = 0; i < 121; i++) {
        await ethers.provider.send("evm_mine", []);
      }

      await p2pEscrow.connect(buyer).raiseDispute(1);
      await p2pEscrow.connect(owner).confirmDisputeResolution(1);
      await p2pEscrow.connect(owner).resolveDispute(1, true);

      expect(await paymentAsset.balanceOf(buyer.address)).to.equal(ethers.parseEther("100"));
      expect(await tokenOffered.balanceOf(seller.address)).to.equal(ethers.parseEther("92"));
    });
  });

  describe("Admin Functions", function () {
    it("should allow owner to set payment asset", async function () {
      const newAsset = await (await ethers.getContractFactory("ERC20Mock")).deploy("New Asset", "NA", ethers.parseEther("1000"));
      await p2pEscrow.connect(owner).setPaymentAsset(newAsset.address, true);
      expect(await p2pEscrow.allowedPaymentAssets(newAsset.address)).to.be.true;
    });

    it("should restrict admin functions to owner", async function () {
      await expect(p2pEscrow.connect(seller).setPaymentAsset(paymentAsset.address, true))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });
  });
});