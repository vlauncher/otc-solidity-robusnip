const { expect } = require("chai");
const { ethers } = require("hardhat");
const { BigNumber } = ethers;

describe("P2PTokenEscrow", function() {
  let owner, seller, buyer;
  let tokenOffered, paymentAsset, priceFeed, escrow;

  before(async function() {
    // Get test accounts
    [owner, seller, buyer] = await ethers.getSigners();

    // Deploy mock ERC20 tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenOffered = await MockERC20.deploy("Token Offered", "TO");
    paymentAsset = await MockERC20.deploy("Payment Asset", "PA");

    // Deploy mock Chainlink price feed
    const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
    priceFeed = await MockV3Aggregator.deploy(8, 100000000); // 8 decimals, price = 1

    // Deploy P2PTokenEscrow contract
    const P2PTokenEscrow = await ethers.getContractFactory("P2PTokenEscrow");
    escrow = await P2PTokenEscrow.deploy(owner.address);

    // Set payment asset as allowed
    await escrow.connect(owner).setPaymentAsset(paymentAsset.address, true);
  });

  it("should create a listing with fixed pricing", async function() {
    const totalAmount = ethers.utils.parseEther("100");
    const fixedPricePerToken = ethers.utils.parseEther("1");

    // Mint tokens to seller
    await tokenOffered.mint(seller.address, totalAmount);

    // Approve escrow to spend tokens
    await tokenOffered.connect(seller).approve(escrow.address, totalAmount);

    // Create listing
    await expect(escrow.connect(seller).createListing(
      tokenOffered.address,
      totalAmount,
      0, // PricingType.FIXED
      fixedPricePerToken,
      0, // discountBps
      paymentAsset.address,
      ethers.constants.AddressZero // priceFeed not used
    )).to.emit(escrow, "ListingCreated").withArgs(1, seller.address);

    // Check listing details
    const listing = await escrow.listings(1);
    expect(listing.seller).to.equal(seller.address);
    expect(listing.tokenOffered).to.equal(tokenOffered.address);
    expect(listing.totalAmount).to.equal(totalAmount);
    expect(listing.remainingAmount).to.equal(totalAmount);
    expect(listing.pricingType).to.equal(0); // FIXED
    expect(listing.fixedPricePerToken).to.equal(fixedPricePerToken);
    expect(listing.discountBps).to.equal(0);
    expect(listing.paymentAsset).to.equal(paymentAsset.address);
    expect(listing.status).to.equal(0); // OPEN
    expect(listing.priceFeed).to.equal(ethers.constants.AddressZero);

    // Check token transfer
    expect(await tokenOffered.balanceOf(escrow.address)).to.equal(totalAmount);
  });

  it("should create a listing with dynamic pricing", async function() {
    const totalAmount = ethers.utils.parseEther("100");
    const discountBps = 500; // 5%

    // Mint tokens to seller
    await tokenOffered.mint(seller.address, totalAmount);

    // Approve escrow to spend tokens
    await tokenOffered.connect(seller).approve(escrow.address, totalAmount);

    // Create listing
    await expect(escrow.connect(seller).createListing(
      tokenOffered.address,
      totalAmount,
      1, // PricingType.DYNAMIC
      0, // fixedPricePerToken not used
      discountBps,
      paymentAsset.address,
      priceFeed.address
    )).to.emit(escrow, "ListingCreated").withArgs(2, seller.address);

    // Check listing details
    const listing = await escrow.listings(2);
    expect(listing.seller).to.equal(seller.address);
    expect(listing.tokenOffered).to.equal(tokenOffered.address);
    expect(listing.totalAmount).to.equal(totalAmount);
    expect(listing.remainingAmount).to.equal(totalAmount);
    expect(listing.pricingType).to.equal(1); // DYNAMIC
    expect(listing.fixedPricePerToken).to.equal(0);
    expect(listing.discountBps).to.equal(discountBps);
    expect(listing.paymentAsset).to.equal(paymentAsset.address);
    expect(listing.status).to.equal(0); // OPEN
    expect(listing.priceFeed).to.equal(priceFeed.address);

    // Check token transfer
    expect(await tokenOffered.balanceOf(escrow.address)).to.equal(totalAmount);
  });

  it("should initiate a trade with fixed pricing", async function() {
    const totalAmount = ethers.utils.parseEther("100");
    const fixedPricePerToken = ethers.utils.parseEther("1");
    const tokenAmount = ethers.utils.parseEther("10");
    const payAmt = fixedPricePerToken.mul(tokenAmount).div(ethers.utils.parseEther("1"));

    // Create listing
    await tokenOffered.mint(seller.address, totalAmount);
    await tokenOffered.connect(seller).approve(escrow.address, totalAmount);
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      totalAmount,
      0, // FIXED
      fixedPricePerToken,
      0,
      paymentAsset.address,
      ethers.constants.AddressZero
    );
    const listingId = 3;

    // Mint payment tokens to buyer
    await paymentAsset.mint(buyer.address, payAmt);

    // Approve escrow to spend payment tokens
    await paymentAsset.connect(buyer).approve(escrow.address, payAmt);

    // Initiate trade
    await expect(escrow.connect(buyer).initiateTrade(listingId, tokenAmount))
      .to.emit(escrow, "TradeInitiated").withArgs(1, listingId, buyer.address);

    // Check trade details
    const trade = await escrow.trades(1);
    expect(trade.buyer).to.equal(buyer.address);
    expect(trade.tokenAmount).to.equal(tokenAmount);
    expect(trade.paymentAmount).to.equal(payAmt);
    expect(trade.buyerConfirmed).to.be.true;
    expect(trade.sellerConfirmed).to.be.false;
    expect(trade.disputed).to.be.false;

    // Check payment transfer
    expect(await paymentAsset.balanceOf(escrow.address)).to.equal(payAmt);

    // Check listing remainingAmount
    const listing = await escrow.listings(listingId);
    expect(listing.remainingAmount).to.equal(totalAmount.sub(tokenAmount));
  });

  it("should initiate a trade with dynamic pricing", async function() {
    const totalAmount = ethers.utils.parseEther("100");
    const discountBps = 500; // 5%
    const tokenAmount = ethers.utils.parseEther("10");

    // Set price feed to return price = 2 (200000000 with 8 decimals)
    await priceFeed.updateAnswer(200000000);

    // Create listing
    await tokenOffered.mint(seller.address, totalAmount);
    await tokenOffered.connect(seller).approve(escrow.address, totalAmount);
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      totalAmount,
      1, // DYNAMIC
      0,
      discountBps,
      paymentAsset.address,
      priceFeed.address
    );
    const listingId = 4;

    // Calculate payAmt
    const price = BigNumber.from(200000000);
    const decimals = 8;
    const qty = tokenAmount;
    const marketValue = price.mul(qty).div(BigNumber.from(10).pow(decimals));
    const discount = marketValue.mul(discountBps).div(10000);
    const payAmt = marketValue.sub(discount);

    // Mint payment tokens to buyer
    await paymentAsset.mint(buyer.address, payAmt);

    // Approve escrow to spend payment tokens
    await paymentAsset.connect(buyer).approve(escrow.address, payAmt);

    // Initiate trade
    await expect(escrow.connect(buyer).initiateTrade(listingId, tokenAmount))
      .to.emit(escrow, "TradeInitiated").withArgs(2, listingId, buyer.address);

    // Check trade details
    const trade = await escrow.trades(2);
    expect(trade.buyer).to.equal(buyer.address);
    expect(trade.tokenAmount).to.equal(tokenAmount);
    expect(trade.paymentAmount).to.equal(payAmt);
    expect(trade.buyerConfirmed).to.be.true;
    expect(trade.sellerConfirmed).to.be.false;
    expect(trade.disputed).to.be.false;

    // Check payment transfer
    expect(await paymentAsset.balanceOf(escrow.address)).to.equal(payAmt);

    // Check listing remainingAmount
    const listing = await escrow.listings(listingId);
    expect(listing.remainingAmount).to.equal(totalAmount.sub(tokenAmount));
  });

  it("should allow seller to release trade", async function() {
    const totalAmount = ethers.utils.parseEther("100");
    const fixedPricePerToken = ethers.utils.parseEther("1");
    const tokenAmount = ethers.utils.parseEther("10");
    const payAmt = fixedPricePerToken.mul(tokenAmount).div(ethers.utils.parseEther("1"));

    // Create listing
    await tokenOffered.mint(seller.address, totalAmount);
    await tokenOffered.connect(seller).approve(escrow.address, totalAmount);
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      totalAmount,
      0, // FIXED
      fixedPricePerToken,
      0,
      paymentAsset.address,
      ethers.constants.AddressZero
    );
    const listingId = 5;

    // Initiate trade
    await paymentAsset.mint(buyer.address, payAmt);
    await paymentAsset.connect(buyer).approve(escrow.address, payAmt);
    await escrow.connect(buyer).initiateTrade(listingId, tokenAmount);
    const tradeId = 3;

    // Seller releases trade
    await expect(escrow.connect(seller).sellerRelease(tradeId))
      .to.emit(escrow, "SellerReleased").withArgs(tradeId);

    // Check trade details
    const trade = await escrow.trades(tradeId);
    expect(trade.sellerConfirmed).to.be.true;

    // Check token transfers
    expect(await tokenOffered.balanceOf(buyer.address)).to.equal(tokenAmount);
    expect(await paymentAsset.balanceOf(seller.address)).to.equal(payAmt);

    // Check listing status
    const listing = await escrow.listings(listingId);
    expect(listing.status).to.equal(2); // COMPLETED
  });

  it("should allow dispute to be raised and resolved", async function() {
    const totalAmount = ethers.utils.parseEther("100");
    const fixedPricePerToken = ethers.utils.parseEther("1");
    const tokenAmount = ethers.utils.parseEther("10");
    const payAmt = fixedPricePerToken.mul(tokenAmount).div(ethers.utils.parseEther("1"));

    // Create listing
    await tokenOffered.mint(seller.address, totalAmount);
    await tokenOffered.connect(seller).approve(escrow.address, totalAmount);
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      totalAmount,
      0, // FIXED
      fixedPricePerToken,
      0,
      paymentAsset.address,
      ethers.constants.AddressZero
    );
    const listingId = 6;

    // Initiate trade
    await paymentAsset.mint(buyer.address, payAmt);
    await paymentAsset.connect(buyer).approve(escrow.address, payAmt);
    await escrow.connect(buyer).initiateTrade(listingId, tokenAmount);
    const tradeId = 4;

    // Advance blocks to allow dispute
    for (let i = 0; i < 121; i++) {
      await ethers.provider.send("evm_mine", []);
    }

    // Raise dispute
    await expect(escrow.connect(buyer).raiseDispute(tradeId))
      .to.emit(escrow, "TradeDisputed").withArgs(tradeId);

    // Check dispute status
    let trade = await escrow.trades(tradeId);
    expect(trade.disputed).to.be.true;
    let listing = await escrow.listings(listingId);
    expect(listing.status).to.equal(4); // DISPUTED

    // Owner confirms dispute resolution
    await escrow.connect(owner).confirmDisputeResolution(tradeId);

    // Resolve dispute in favor of buyer
    await expect(escrow.connect(owner).resolveDispute(tradeId, true))
      .to.emit(escrow, "TradeResolved").withArgs(tradeId, true);

    // Check token transfers
    expect(await paymentAsset.balanceOf(buyer.address)).to.equal(payAmt);
    expect(await tokenOffered.balanceOf(seller.address)).to.equal(totalAmount);

    // Check final status
    trade = await escrow.trades(tradeId);
    expect(trade.disputed).to.be.false;
    listing = await escrow.listings(listingId);
    expect(listing.status).to.equal(3); // CANCELLED
  });
});