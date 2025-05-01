const { expect } = require("chai");
const { ethers } = require("hardhat");
const { utils } = require("ethers");

describe("P2PTokenEscrow", function () {
  let escrow, owner, seller, buyer, other;
  let tokenOffered, paymentAsset, priceFeed;
  let initialSupply;
  let fixedPricePerToken;
  const discountBps = 500; // 5% discount

  beforeEach(async function () {
    initialSupply = ethers.utils.parseEther("1000");
    fixedPricePerToken = ethers.utils.parseEther("1");

    [owner, seller, buyer, other] = await ethers.getSigners();

    // Deploy MockERC20 token for offered tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenOffered = await MockERC20.deploy("TokenOffered", "TOK", initialSupply);
    await tokenOffered.deployed();

    // Deploy MockERC20 token for payment asset
    paymentAsset = await MockERC20.deploy("PaymentAsset", "PAY", initialSupply);
    await paymentAsset.deployed();

    // Deploy MockPriceFeed with price = 2 * 10^8 (8 decimals)
    const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
    priceFeed = await MockPriceFeed.deploy(ethers.BigNumber.from("200000000"), 8);
    await priceFeed.deployed();

    // Deploy P2PTokenEscrow contract with owner
    const P2PTokenEscrow = await ethers.getContractFactory("P2PTokenEscrow");
    escrow = await P2PTokenEscrow.deploy(owner.address);
    await escrow.deployed();

    // Owner sets allowed payment asset
    await escrow.connect(owner).setPaymentAsset(paymentAsset.address, true);

    // Transfer tokens to seller and buyer
    await tokenOffered.transfer(seller.address, initialSupply);
    await paymentAsset.transfer(buyer.address, initialSupply);
  });

  it("should allow seller to create a listing", async function () {
    await tokenOffered.connect(seller).approve(escrow.address, ethers.utils.parseEther("100"));

    const tx = await escrow.connect(seller).createListing(
      tokenOffered.address,
      ethers.utils.parseEther("100"),
      0, // FIXED pricing
      fixedPricePerToken,
      0,
      paymentAsset.address,
      ethers.constants.AddressZero
    );

    const receipt = await tx.wait();
    const event = receipt.events.find(e => e.event === "ListingCreated");
    expect(event.args.seller).to.equal(seller.address);
    expect(event.args.id).to.equal(1);

    const listing = await escrow.listings(1);
    expect(listing.totalAmount).to.equal(ethers.utils.parseEther("100"));
    expect(listing.remainingAmount).to.equal(ethers.utils.parseEther("100"));
    expect(listing.status).to.equal(0); // OPEN
  });

  it("should allow buyer to initiate trade and seller to release tokens", async function () {
    // Seller creates listing
    await tokenOffered.connect(seller).approve(escrow.address, ethers.utils.parseEther("100"));
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      ethers.utils.parseEther("100"),
      0, // FIXED pricing
      fixedPricePerToken,
      0,
      paymentAsset.address,
      ethers.constants.AddressZero
    );

    // Buyer approves payment asset
    const payAmount = fixedPricePerToken.mul(ethers.utils.parseEther("10")).div(ethers.utils.parseEther("1"));
    await paymentAsset.connect(buyer).approve(escrow.address, payAmount);

    // Initiate trade for 10 tokens
    const tx = await escrow.connect(buyer).initiateTrade(1, ethers.utils.parseEther("10"));
    const receipt = await tx.wait();
    const event = receipt.events.find(e => e.event === "TradeInitiated");
    expect(event.args.buyer).to.equal(buyer.address);
    expect(event.args.tradeId).to.equal(1);

    // Seller releases tokens
    await escrow.connect(seller).sellerRelease(1);

    // Check balances
    expect(await tokenOffered.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("10"));
    expect(await paymentAsset.balanceOf(seller.address)).to.equal(payAmount);
  });

  it("should allow raising and resolving dispute", async function () {
    // Seller creates listing
    await tokenOffered.connect(seller).approve(escrow.address, ethers.utils.parseEther("100"));
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      ethers.utils.parseEther("100"),
      0,
      fixedPricePerToken,
      0,
      paymentAsset.address,
      ethers.constants.AddressZero
    );

    // Buyer approves payment asset and initiates trade
    const payAmount = fixedPricePerToken.mul(ethers.utils.parseEther("10")).div(ethers.utils.parseEther("1"));
    await paymentAsset.connect(buyer).approve(escrow.address, payAmount);
    await escrow.connect(buyer).initiateTrade(1, ethers.utils.parseEther("10"));

    // Advance blocks to simulate time passing (Hardhat network)
    for (let i = 0; i < 121; i++) {
      await ethers.provider.send("evm_mine");
    }

    // Buyer raises dispute
    await escrow.connect(buyer).raiseDispute(1);
    let trade = await escrow.trades(1);
    expect(trade.disputed).to.be.true;

    // Owner confirms dispute resolution twice (simulate multi-sig)
    await escrow.connect(owner).confirmDisputeResolution(1);
    await escrow.connect(owner).confirmDisputeResolution(1);

    // Resolve dispute refunding buyer
    await escrow.connect(owner).resolveDispute(1, true);

    trade = await escrow.trades(1);
    expect(trade.disputed).to.be.false;

    // Buyer should get payment back, seller gets tokens back
    expect(await paymentAsset.balanceOf(buyer.address)).to.equal(initialSupply);
    expect(await tokenOffered.balanceOf(seller.address)).to.equal(initialSupply);
  });

  it("should calculate dynamic pricing correctly", async function () {
    // Seller creates listing with dynamic pricing and discount
    await tokenOffered.connect(seller).approve(escrow.address, ethers.utils.parseEther("100"));
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      ethers.utils.parseEther("100"),
      1, // DYNAMIC pricing
      0,
      discountBps,
      paymentAsset.address,
      priceFeed.address
    );

    // Calculate expected payment:
    // priceFeed price = 2 * 10^8 (8 decimals)
    // qty = 10 tokens
    // marketValue = 2 * 10 = 20 paymentAsset units
    // discount 5% = 1 paymentAsset unit
    // expected payment = 19 paymentAsset units

    const qty = ethers.utils.parseEther("10");
    const marketValue = ethers.BigNumber.from("200000000").mul(qty).div(ethers.utils.parseEther("1"));
    const discount = marketValue.mul(discountBps).div(10000);
    const expectedPay = marketValue.sub(discount);

    await paymentAsset.connect(buyer).approve(escrow.address, expectedPay);

    // Initiate trade
    await escrow.connect(buyer).initiateTrade(1, qty);

    // Check trade payment amount
    const trade = await escrow.trades(1);
    expect(trade.paymentAmount).to.equal(expectedPay);
  });

  it("should reject creating listing with disallowed payment asset", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const disallowedPaymentAsset = await MockERC20.deploy("Disallowed", "DIS", initialSupply);
    await disallowedPaymentAsset.deployed();

    await tokenOffered.connect(seller).approve(escrow.address, ethers.utils.parseEther("100"));

    await expect(
      escrow.connect(seller).createListing(
        tokenOffered.address,
        ethers.utils.parseEther("100"),
        0,
        fixedPricePerToken,
        0,
        disallowedPaymentAsset.address,
        ethers.constants.AddressZero
      )
    ).to.be.revertedWith("Payment asset not allowed");
  });

  it("should reject trade initiation if listing expired", async function () {
    await tokenOffered.connect(seller).approve(escrow.address, ethers.utils.parseEther("100"));
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      ethers.utils.parseEther("100"),
      0,
      fixedPricePerToken,
      0,
      paymentAsset.address,
      ethers.constants.AddressZero
    );

    // Advance blocks beyond MAX_BLOCKS
    for (let i = 0; i < 121; i++) {
      await ethers.provider.send("evm_mine");
    }

    await paymentAsset.connect(buyer).approve(escrow.address, ethers.utils.parseEther("10"));

    await expect(
      escrow.connect(buyer).initiateTrade(1, ethers.utils.parseEther("10"))
    ).to.be.revertedWith("Listing expired");
  });

  it("should reject unauthorized seller release", async function () {
    await tokenOffered.connect(seller).approve(escrow.address, ethers.utils.parseEther("100"));
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      ethers.utils.parseEther("100"),
      0,
      fixedPricePerToken,
      0,
      paymentAsset.address,
      ethers.constants.AddressZero
    );

    await paymentAsset.connect(buyer).approve(escrow.address, ethers.utils.parseEther("10"));
    await escrow.connect(buyer).initiateTrade(1, ethers.utils.parseEther("10"));

    // Attempt release by non-seller
    await expect(
      escrow.connect(buyer).sellerRelease(1)
    ).to.be.revertedWith("Only seller");
  });

  it("should reject dispute raised too early", async function () {
    await tokenOffered.connect(seller).approve(escrow.address, ethers.utils.parseEther("100"));
    await escrow.connect(seller).createListing(
      tokenOffered.address,
      ethers.utils.parseEther("100"),
      0,
      fixedPricePerToken,
      0,
      paymentAsset.address,
      ethers.constants.AddressZero
    );

    await paymentAsset.connect(buyer).approve(escrow.address, ethers.utils.parseEther("10"));
    await escrow.connect(buyer).initiateTrade(1, ethers.utils.parseEther("10"));

    // Attempt to raise dispute immediately (too early)
    await expect(
      escrow.connect(buyer).raiseDispute(1)
    ).to.be.revertedWith("Too early");
  });

});
