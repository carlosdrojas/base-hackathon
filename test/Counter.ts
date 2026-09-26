import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.getOrCreate();

describe("Counter", function () {
  it("starts at zero", async function () {
    const counter = await ethers.deployContract("Counter");
    expect(await counter.count()).to.equal(0n);
  });

  it("increments and decrements", async function () {
    const counter = await ethers.deployContract("Counter");

    await counter.increment();
    expect(await counter.count()).to.equal(1n);

    await counter.decrement();
    expect(await counter.count()).to.equal(0n);
  });

  it("reverts when decrementing below zero", async function () {
    const counter = await ethers.deployContract("Counter");
    await expect(counter.decrement()).to.be.revertedWith(
      "Counter: cannot go below zero",
    );
  });
});
