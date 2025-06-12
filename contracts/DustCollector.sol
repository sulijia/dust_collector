// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interface.sol";
import "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import "@uniswap/universal-router/lib/permit2/src/interfaces/IPermit2.sol";


contract DustCollector {
    address public routerAddr;
    address public uniRouterAddr;
    IUniversalRouter public universalRouter;
    IPermit2 public immutable permit2;
    address public permit2Addr;
    uint8 constant V2_SWAP_EXACT_IN = 0x08;

    constructor(address _router, address _uni_router, address _permit2) {
        routerAddr = _router;
        uniRouterAddr = _uni_router;
        universalRouter = IUniversalRouter(_uni_router);
        permit2Addr = _permit2;
        permit2 = IPermit2(_permit2);
    }

    function  swapDust(address[] memory tokens, address to) external {

        IUniswapV2Router02 router = IUniswapV2Router02(routerAddr);
        address[] memory path = new address[](2);

        for (uint256 index = 0; index < tokens.length; index++) {
            address otherToken = tokens[index];
            uint256 amount = IERC20(otherToken).balanceOf( msg.sender );
            if(amount != 0) {
                IERC20(otherToken).transferFrom(msg.sender, address(this), amount);
                if(IERC20(otherToken).allowance(address(this), routerAddr) < amount) {
                    IERC20(otherToken).approve(routerAddr, type(uint256).max);
                }
                path[0] = otherToken;
                path[1] = to;
                uint256[] memory amounts = router.getAmountsOut(amount, path);
                uint256 tokenAmountEst = amounts[amounts.length - 1];
                tokenAmountEst = tokenAmountEst*80/100; //slippage 20%
                uint256[] memory amountsR = router.swapExactTokensForTokens(amount, tokenAmountEst, path, msg.sender, block.timestamp);
                require(amountsR[amountsR.length-1] >= tokenAmountEst, "amount smaller than estimate");
            }
        }
    }

    function  swapDustUni(address[] memory tokens, address to) external {
        address[] memory path = new address[](2);
        bytes[] memory inputs = new bytes[](1);

        for (uint256 index = 0; index < tokens.length; index++) {
            address otherToken = tokens[index];
            uint256 amount = IERC20(otherToken).balanceOf( msg.sender );
            IERC20(otherToken).transferFrom(msg.sender, address(this), amount);
            IERC20(otherToken).approve(address(permit2), type(uint256).max);
            permit2.approve(
            otherToken,
            address(universalRouter),
            type(uint160).max,
            type(uint48).max
            );

            bytes memory commands = abi.encodePacked(
                bytes1(uint8(V2_SWAP_EXACT_IN))
            );
            path[0] = otherToken;
            path[1] = to;
            inputs[0] = abi.encode(address(msg.sender), amount, 0, path, true);

            uint256 deadline = block.timestamp + 1800;

            universalRouter.execute(commands, inputs, deadline);
        }
    }
}
